import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CodexAdapter } from '../src/adapters/codex/adapter.js';
import { installCodexHooks } from '../src/adapters/codex/setup.js';
import { compileContext } from '../src/context/compiler.js';
import type { WorkspaceState } from '../src/core/events.js';
import type { StoredEvent } from '../src/db/database.js';
import { scoreContextFidelity } from '../src/evals/fidelity.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

const workspace: WorkspaceState = {
  cwd: '/work/payments',
  gitHead: 'abc123',
  gitStatus: ' M src/auth/refresh.ts\n M src/auth/session.ts',
};

describe('CodexAdapter', () => {
  it('normalizes a representative hook stream without reading a transcript', () => {
    const adapter = new CodexAdapter(() => workspace, () => '2026-08-19T12:00:00.000Z', () => 'hook-id');
    const events: StoredEvent[] = [
      ...adapter.normalize({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'codex-session',
        cwd: '/work/payments',
        event_id: 'prompt',
        prompt: 'Fix refresh concurrency. Do not change the public API.',
      }),
      ...adapter.normalize({
        hook_event_name: 'PostToolUse',
        session_id: 'codex-session',
        cwd: '/work/payments',
        event_id: 'test',
        tool_name: 'exec_command',
        tool_response: 'refresh_concurrency failed with exit code 1',
      }),
      ...adapter.normalize({
        hook_event_name: 'Stop',
        session_id: 'codex-session',
        cwd: '/work/payments',
        event_id: 'stop',
        last_assistant_message: 'We decided to serialize refreshes per session.',
      }),
    ].map((event, index) => ({ ...event, sequence: index + 1 }));

    const context = compileContext(events);
    expect(scoreContextFidelity(context, [
      { facet: 'currentObjective', expected: 'Fix refresh concurrency. Do not change the public API.' },
      { facet: 'userRequirements', expected: 'Fix refresh concurrency. Do not change the public API.' },
      { facet: 'importantDecisions', expected: 'We decided to serialize refreshes per session.' },
      { facet: 'modifiedFiles', expected: 'src/auth/refresh.ts' },
      { facet: 'recentFailures', expected: 'refresh_concurrency failed with exit code 1' },
    ])).toEqual({ total: 5, passed: 5, failures: [] });
    expect(events.some((event) => event.trustClass === 'tool')).toBe(true);
    expect(events.filter((event) => event.type === 'file_change')).toHaveLength(6);
  });

  it('ignores unsupported hook events and rejects supported events without a session identifier', () => {
    const adapter = new CodexAdapter(() => workspace, () => '2026-08-19T12:00:00.000Z', () => 'hook-id');

    expect(adapter.normalize({ hook_event_name: 'UnknownFutureEvent' })).toEqual([]);
    expect(() => adapter.normalize({ hook_event_name: 'PostToolUse' })).toThrow('missing session_id');
  });

  it('preserves structured tool output and accepts Codex event-name aliases', () => {
    const adapter = new CodexAdapter(() => workspace, () => '2026-08-19T12:00:00.000Z', () => 'hook-id');

    const [event] = adapter.normalize({
      eventName: 'post-tool-use',
      sessionId: 'codex-session',
      toolName: 'exec_command',
      toolResponse: { exitCode: 1, output: 'failed' },
    });

    expect(event).toMatchObject({
      type: 'tool_result',
      trustClass: 'tool',
      payload: { tool: 'exec_command', output: { exitCode: 1, output: 'failed' } },
    });
  });

  it('merges Ghost hooks without replacing existing project hook entries', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ghostd-codex-hooks-'));
    temporaryDirectories.push(directory);
    const configDirectory = join(directory, '.codex');
    await mkdir(configDirectory, { recursive: true });
    const hookFile = join(configDirectory, 'hooks.json');
    await writeFile(hookFile, JSON.stringify({ hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'existing-hook' }] }] } }));

    await installCodexHooks(directory, 'ghost codex-hook');
    await installCodexHooks(directory, 'ghost codex-hook');

    const config = JSON.parse(await readFile(hookFile, 'utf8')) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }> > };
    expect(config.hooks.Stop?.[0]?.hooks.map(({ command }) => command)).toEqual(['existing-hook', 'ghost codex-hook']);
    expect(config.hooks.UserPromptSubmit?.[0]?.hooks.map(({ command }) => command)).toEqual(['ghost codex-hook']);
    expect(await readFile(join(configDirectory, 'config.toml'), 'utf8')).toBe('[features]\nhooks = true\n');
  });

  it('enables hooks in an existing Codex config without replacing other settings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ghostd-codex-config-'));
    temporaryDirectories.push(directory);
    const configDirectory = join(directory, '.codex');
    await mkdir(configDirectory, { recursive: true });
    const configPath = join(configDirectory, 'config.toml');
    await writeFile(configPath, '[features]\nexperimental = true\nhooks = false # disabled\n\n[profiles.fast]\nmodel = "fast"\n');

    await installCodexHooks(directory, 'ghost codex-hook');

    expect(await readFile(configPath, 'utf8')).toBe(
      '[features]\nexperimental = true\nhooks = true # disabled\n\n[profiles.fast]\nmodel = "fast"\n',
    );
  });

  it('rejects malformed hook configuration rather than overwriting it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ghostd-codex-invalid-'));
    temporaryDirectories.push(directory);
    const configDirectory = join(directory, '.codex');
    await mkdir(configDirectory, { recursive: true });
    await writeFile(join(configDirectory, 'hooks.json'), JSON.stringify({ hooks: [] }));

    await expect(installCodexHooks(directory, 'ghost codex-hook')).rejects.toThrow('Codex hooks configuration must be a JSON object');
  });
});
