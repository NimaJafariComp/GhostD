import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { LocalBridgeClientRegistry, LocalBridgeConfigurationStore, LocalBridgeServer, readLocalBridgeClientCredentials, requestLocalBridge, writeLocalBridgeClientCredentials } from '../src/ecosystem/bridge.js';
import type { GhostEvent } from '../src/core/events.js';
import { GhostDatabase } from '../src/db/database.js';
import { readBridgeCredentials as readVsCodeBridgeCredentials, requestBridge as requestVsCodeBridge } from '../extensions/vscode/src/bridge-client.js';

const temporaryDirectories: string[] = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true }))));

function event(id: string, sessionId: string, cwd: string, type: GhostEvent['type'], payload: Record<string, unknown>): GhostEvent {
  return {
    schemaVersion: 1,
    id,
    sessionId,
    timestamp: '2026-08-20T12:00:00.000Z',
    source: 'codex',
    type,
    trustClass: type === 'user_message' ? 'user' : 'tool',
    payload,
    workspace: { cwd, gitHead: 'abc', gitStatus: '' },
  };
}

describe('Phase 7.1 local bridge', () => {
  it('authenticates a workspace-bound client and exposes only the approved bridge surface', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ghostd-local-bridge-'));
    temporaryDirectories.push(directory);
    const workspace = join(directory, 'workspace-a');
    const otherWorkspace = join(directory, 'workspace-b');
    const databasePath = join(directory, 'ghost.db');
    const database = await GhostDatabase.open(databasePath);
    try {
      database.append(event('main-user', 'main-session', workspace, 'user_message', { text: 'Current objective is bridge verification.' }));
      database.append(event('main-tool', 'main-session', workspace, 'tool_result', { authorization: 'Bearer should-never-leave-storage', output: 'checked' }));
      const mainRevision = database.createRevision('main-session');
      database.createBranch('main', mainRevision.id);
      database.append(event('other-user', 'other-session', otherWorkspace, 'user_message', { text: 'Other workspace objective.' }));
      const otherRevision = database.createRevision('other-session');
      database.createBranch('other', otherRevision.id);
    } finally {
      database.close();
    }

    const configuration = await new LocalBridgeConfigurationStore(join(directory, 'bridge.json'), join(directory, 'bridge.sock')).loadOrCreate('2026-08-20T12:00:00.000Z');
    const registry = new LocalBridgeClientRegistry(join(directory, 'bridge-clients.json'));
    const client = await registry.register('vscode', workspace, configuration.endpoint, '2026-08-20T12:00:00.000Z');
    const extensionCredentialPath = join(directory, 'vscode-storage', 'bridge.json');
    await writeLocalBridgeClientCredentials(extensionCredentialPath, client);
    const server = new LocalBridgeServer({
      databasePath,
      configuration,
      clientRegistry: registry,
      capabilityResolver: async () => [{ host: 'codex', state: 'supported and verified' }],
    });
    await server.listen();
    try {
      expect((await stat(join(directory, 'bridge.json'))).mode & 0o777).toBe(0o600);
      expect((await stat(join(directory, 'bridge-clients.json'))).mode & 0o777).toBe(0o600);
      expect(await requestLocalBridge(client, 'initialize')).toMatchObject({ protocol: 'ghostd/local-bridge/1' });
      expect(await requestVsCodeBridge(await readVsCodeBridgeCredentials(extensionCredentialPath), 'initialize')).toMatchObject({ protocol: 'ghostd/local-bridge/1' });
      expect(await requestLocalBridge(client, 'capture/status')).toMatchObject({
        workspaceCwd: workspace,
        capabilities: [{ host: 'codex', state: 'supported and verified' }],
      });
      expect(await requestLocalBridge(client, 'sessions/list')).toMatchObject({
        workspaceCwd: workspace,
        sessions: [expect.objectContaining({ sourceSessionId: 'main-session', workspaceCwd: workspace })],
      });

      const context = await requestLocalBridge(client, 'context/read', { provenance: true });
      expect(context['context']).toContain('Current objective is bridge verification.');
      expect(context['context']).not.toContain('should-never-leave-storage');
      expect(await requestLocalBridge(client, 'branches/status', { branch: 'main' })).toMatchObject({ status: { branch: { name: 'main' } } });
      const handoff = await requestLocalBridge(client, 'handoff/read', { branch: 'main' });
      expect(handoff).toMatchObject({ handoff: { protocol: 'ghostd/acp-handoff/1', providerSession: null } });
      expect(JSON.stringify(handoff)).not.toContain('should-never-leave-storage');

      await expect(requestLocalBridge(client, 'branches/status', { branch: 'other' })).rejects.toThrow('outside this client workspace');
      await expect(requestLocalBridge({ ...client, token: '0'.repeat(64) }, 'sessions/list')).rejects.toThrow('Unauthorized local bridge client.');
      await expect(requestLocalBridge({ ...client, workspaceCwd: otherWorkspace }, 'sessions/list')).rejects.toThrow('Unauthorized local bridge client.');
      expect(await readFile(join(directory, 'bridge-clients.json'), 'utf8')).toContain('vscode');
    } finally {
      await server.close();
    }
  });

  it('rotates client credentials and makes revoked clients unusable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ghostd-local-bridge-registry-'));
    temporaryDirectories.push(directory);
    const registry = new LocalBridgeClientRegistry(join(directory, 'clients.json'));
    const workspace = join(directory, 'workspace');
    const first = await registry.register('vscode', workspace, join(directory, 'bridge.sock'));
    const second = await registry.register('vscode', workspace, join(directory, 'bridge.sock'));
    expect(second.token).not.toBe(first.token);
    expect(await registry.authenticate('vscode', first.token, workspace)).toBe(false);
    expect(await registry.authenticate('vscode', second.token, workspace)).toBe(true);
    expect(await registry.revoke('vscode')).toBe(true);
    expect(await registry.authenticate('vscode', second.token, workspace)).toBe(false);
    const credentialPath = join(directory, 'vscode', 'bridge.json');
    await writeLocalBridgeClientCredentials(credentialPath, second);
    expect(await readLocalBridgeClientCredentials(credentialPath)).toEqual(second);
    expect((await stat(credentialPath)).mode & 0o777).toBe(0o600);
  });
});
