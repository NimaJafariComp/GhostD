import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { acpHandoff } from '../src/acp/handoff.js';
import { IntegrationConfigStore } from '../src/ecosystem/config.js';
import { installVsCodeTasks } from '../src/ecosystem/vscode.js';
import { GhostMcpServer } from '../src/mcp/server.js';
import type { GhostEvent } from '../src/core/events.js';
import { GhostDatabase } from '../src/db/database.js';

const temporaryDirectories: string[] = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true }))));

async function databaseFixture(): Promise<{ database: GhostDatabase; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'ghostd-ecosystem-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'ghost.db');
  const database = await GhostDatabase.open(path);
  const event: GhostEvent = { schemaVersion: 1, id: 'event-1', sessionId: 'session-1', timestamp: '2026-08-19T12:00:00.000Z', source: 'codex', type: 'user_message', trustClass: 'user', payload: { text: 'Current objective.' }, workspace: { cwd: '/work/ghost', gitHead: 'abc', gitStatus: '' } };
  database.append(event);
  const revision = database.createRevision(event.sessionId);
  database.createBranch('main', revision.id);
  return { database, path };
}

describe('Phase 6 ecosystem integrations', () => {
  it('stores provider intent without secrets', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ghostd-config-'));
    temporaryDirectories.push(directory);
    const store = new IntegrationConfigStore(join(directory, 'config.json'));
    await store.setProvider('claude', 'subscription', '2026-08-19T12:00:00.000Z');
    await store.setProvider('gemini', 'api', '2026-08-19T12:01:00.000Z');
    expect(await store.load()).toEqual({ version: 1, providers: { claude: { mode: 'subscription', updatedAt: '2026-08-19T12:00:00.000Z' }, gemini: { mode: 'api', updatedAt: '2026-08-19T12:01:00.000Z' } } });
  });

  it('serves only deterministic read-only context over MCP and ACP handoff boundaries', async () => {
    const { database, path } = await databaseFixture();
    try {
      const mcp = new GhostMcpServer(path);
      expect(await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize' })).toMatchObject({ result: { capabilities: { tools: {}, resources: {} } } });
      expect(await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).toMatchObject({ result: { tools: [expect.objectContaining({ name: 'ghost_context' }), expect.objectContaining({ name: 'ghost_branch_status' })] } });
      expect(await mcp.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ghost_context', arguments: { provenance: true } } })).toMatchObject({ result: { structuredContent: { context: expect.stringContaining('Current objective.') } } });
      expect(acpHandoff(database, 'main')).toMatchObject({ protocol: 'ghostd/acp-handoff/1', sessionOwner: 'ghostd', providerSession: null, branch: 'main' });
    } finally { database.close(); }
  });

  it('adds VS Code tasks without replacing user-defined tasks', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ghostd-vscode-'));
    temporaryDirectories.push(directory);
    await mkdir(join(directory, '.vscode'));
    await writeFile(join(directory, '.vscode', 'tasks.json'), JSON.stringify({ version: '2.0.0', tasks: [{ label: 'User task', type: 'shell', command: 'echo user' }] }));
    const path = await installVsCodeTasks(directory, 'ghost');
    const tasks = JSON.parse(await readFile(path, 'utf8')) as { tasks: Array<{ label: string }> };
    expect(tasks.tasks.map(({ label }) => label)).toEqual(['User task', 'GhostD: Context', 'GhostD: MCP']);
  });
});
