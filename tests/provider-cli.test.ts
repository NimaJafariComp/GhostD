import { describe, expect, it } from 'vitest';

import { ProviderCliInstallError, ProviderCliManager } from '../src/adapters/provider-cli.js';
import type { CommandResult, CommandRunner } from '../src/adapters/provider-cli.js';

class FixtureRunner implements CommandRunner {
  public readonly calls: Array<{ command: string; arguments_: readonly string[] }> = [];

  public constructor(private readonly responses: CommandResult[]) {}

  public async run(command: string, arguments_: readonly string[]): Promise<CommandResult> {
    this.calls.push({ command, arguments_ });
    const response = this.responses.shift();
    if (response === undefined) {
      throw new Error(`Unexpected command: ${command} ${arguments_.join(' ')}`);
    }
    return response;
  }
}

describe('ProviderCliManager', () => {
  it('reports installed and missing official provider CLIs without checking authentication', async () => {
    const runner = new FixtureRunner([
      { status: 'completed', exitCode: 0, stdout: 'codex 1.2.3\n' },
      { status: 'not_found' },
      { status: 'completed', exitCode: 1, stdout: '' },
    ]);
    const manager = new ProviderCliManager(runner);

    await expect(manager.statuses()).resolves.toEqual([
      expect.objectContaining({ provider: 'codex', installed: true, version: 'codex 1.2.3' }),
      expect.objectContaining({ provider: 'claude', installed: false, packageName: '@anthropic-ai/claude-code' }),
      expect.objectContaining({ provider: 'gemini', installed: true }),
    ]);
    expect(runner.calls).toEqual([
      { command: 'codex', arguments_: ['--version'] },
      { command: 'claude', arguments_: ['--version'] },
      { command: 'gemini', arguments_: ['--version'] },
    ]);
  });

  it('installs only a requested missing CLI using its fixed official package', async () => {
    const runner = new FixtureRunner([
      { status: 'not_found' },
      { status: 'completed', exitCode: 0, stdout: '' },
      { status: 'completed', exitCode: 0, stdout: 'Claude Code 2.0.0\n' },
    ]);
    const manager = new ProviderCliManager(runner);

    await expect(manager.install('claude')).resolves.toMatchObject({ installed: true, version: 'Claude Code 2.0.0' });
    expect(runner.calls).toEqual([
      { command: 'claude', arguments_: ['--version'] },
      { command: 'npm', arguments_: ['install', '--global', '@anthropic-ai/claude-code'] },
      { command: 'claude', arguments_: ['--version'] },
    ]);
  });

  it('fails safely when npm is unavailable or an installer fails', async () => {
    const npmMissing = new ProviderCliManager(new FixtureRunner([{ status: 'not_found' }, { status: 'not_found' }]));
    await expect(npmMissing.install('gemini')).rejects.toEqual(new ProviderCliInstallError('gemini', 'npm_missing'));

    const npmFailed = new ProviderCliManager(new FixtureRunner([
      { status: 'not_found' },
      { status: 'completed', exitCode: 1, stdout: 'do not display installer output' },
    ]));
    await expect(npmFailed.install('codex')).rejects.toEqual(new ProviderCliInstallError('codex', 'install_failed'));
  });
});
