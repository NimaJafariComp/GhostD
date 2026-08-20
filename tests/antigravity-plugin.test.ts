import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { AntigravityPluginError, AntigravityPluginManager } from '../src/adapters/antigravity/plugin.js';
import type { AntigravityCommandResult, AntigravityCommandRunner } from '../src/adapters/antigravity/plugin.js';
import { antigravityHookEvents } from '../src/adapters/antigravity/source.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = join(repositoryRoot, 'integrations', 'antigravity', 'ghostd');

class FixtureRunner implements AntigravityCommandRunner {
  public readonly calls: Array<{ command: string; arguments_: readonly string[] }> = [];

  public constructor(private readonly responses: AntigravityCommandResult[]) {}

  public async run(command: string, arguments_: readonly string[]): Promise<AntigravityCommandResult> {
    this.calls.push({ command, arguments_ });
    const response = this.responses.shift();
    if (response === undefined) throw new Error(`Unexpected command: ${command} ${arguments_.join(' ')}`);
    return response;
  }
}

describe('GhostD Antigravity plugin', () => {
  it('packages only non-gating documented hooks and GhostD read-only MCP', async () => {
    const manifest = JSON.parse(await readFile(join(pluginRoot, 'plugin.json'), 'utf8')) as { name: string; description: string };
    const hooks = JSON.parse(await readFile(join(pluginRoot, 'hooks.json'), 'utf8')) as Record<string, Record<string, unknown>>;
    const mcp = JSON.parse(await readFile(join(pluginRoot, 'mcp_config.json'), 'utf8')) as { mcpServers: Record<string, { command: string; args: string[] }> };

    expect(manifest).toMatchObject({ name: 'ghostd' });
    const capture = hooks['ghostd-capture'];
    expect(capture).toBeDefined();
    expect(Object.keys(capture ?? {})).toEqual([...antigravityHookEvents]);
    expect(JSON.stringify(capture)).not.toContain('PreToolUse');
    expect(JSON.stringify(capture)).not.toContain('decision');
    expect(mcp).toEqual({ mcpServers: { ghostd: { command: 'ghost', args: ['mcp'] } } });
  });

  it('uses only documented agy plugin commands and fails safely when the CLI is unavailable', async () => {
    const runner = new FixtureRunner([
      { status: 'completed', exitCode: 0, stdout: 'ghostd enabled\n' },
      { status: 'completed', exitCode: 0, stdout: '' },
      { status: 'completed', exitCode: 0, stdout: '' },
      { status: 'completed', exitCode: 0, stdout: '' },
      { status: 'completed', exitCode: 0, stdout: '' },
    ]);
    const manager = new AntigravityPluginManager('/plugin/ghostd', runner);

    await expect(manager.status()).resolves.toEqual({ available: true, installed: true, pluginPath: '/plugin/ghostd' });
    await manager.install();
    await manager.disable();
    await manager.enable();
    await manager.uninstall();
    expect(runner.calls).toEqual([
      { command: 'agy', arguments_: ['plugin', 'list'] },
      { command: 'agy', arguments_: ['plugin', 'install', '/plugin/ghostd'] },
      { command: 'agy', arguments_: ['plugin', 'disable', 'ghostd'] },
      { command: 'agy', arguments_: ['plugin', 'enable', 'ghostd'] },
      { command: 'agy', arguments_: ['plugin', 'uninstall', 'ghostd'] },
    ]);

    const unavailable = new AntigravityPluginManager('/plugin/ghostd', new FixtureRunner([{ status: 'not_found' }]));
    await expect(unavailable.install()).rejects.toEqual(new AntigravityPluginError('install', 'cli_unavailable'));
  });
});
