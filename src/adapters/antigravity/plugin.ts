import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export type AntigravityCommandResult =
  | { status: 'completed'; exitCode: number | null; stdout: string }
  | { status: 'not_found' }
  | { status: 'failed_to_start' };

export interface AntigravityCommandRunner {
  run(command: string, arguments_: readonly string[]): Promise<AntigravityCommandResult>;
}

export interface AntigravityPluginStatus {
  available: boolean;
  installed: boolean;
  pluginPath: string;
}

export class AntigravityPluginError extends Error {
  public constructor(action: 'install' | 'enable' | 'disable' | 'uninstall', reason: 'cli_unavailable' | 'command_failed') {
    super(reason === 'cli_unavailable'
      ? `Could not ${action} the GhostD Antigravity plugin: the agy CLI is not available.`
      : `Could not ${action} the GhostD Antigravity plugin: Antigravity rejected the command.`);
    this.name = 'AntigravityPluginError';
  }
}

/** The native plugin ships alongside the CLI and is intentionally free of credentials and hidden-state access. */
export function bundledAntigravityPluginPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../integrations/antigravity/ghostd');
}

export class AntigravityPluginManager {
  public constructor(
    private readonly pluginPath = bundledAntigravityPluginPath(),
    private readonly runner: AntigravityCommandRunner = new ChildProcessAntigravityRunner(),
  ) {}

  public async status(): Promise<AntigravityPluginStatus> {
    const result = await this.runner.run('agy', ['plugin', 'list']);
    if (result.status !== 'completed' || result.exitCode !== 0) {
      return { available: result.status !== 'not_found', installed: false, pluginPath: this.pluginPath };
    }
    return { available: true, installed: pluginListed(result.stdout), pluginPath: this.pluginPath };
  }

  public async install(): Promise<void> {
    await this.run('install', ['plugin', 'install', this.pluginPath]);
  }

  public async enable(): Promise<void> {
    await this.run('enable', ['plugin', 'enable', 'ghostd']);
  }

  public async disable(): Promise<void> {
    await this.run('disable', ['plugin', 'disable', 'ghostd']);
  }

  public async uninstall(): Promise<void> {
    await this.run('uninstall', ['plugin', 'uninstall', 'ghostd']);
  }

  private async run(action: 'install' | 'enable' | 'disable' | 'uninstall', arguments_: string[]): Promise<void> {
    const result = await this.runner.run('agy', arguments_);
    if (result.status === 'not_found') throw new AntigravityPluginError(action, 'cli_unavailable');
    if (result.status !== 'completed' || result.exitCode !== 0) throw new AntigravityPluginError(action, 'command_failed');
  }
}

function pluginListed(output: string): boolean {
  return output.split(/\r?\n/).some((line) => /(^|[\s,:"'])ghostd(?=$|[\s,:"'])/.test(line));
}

class ChildProcessAntigravityRunner implements AntigravityCommandRunner {
  public async run(command: string, arguments_: readonly string[]): Promise<AntigravityCommandResult> {
    return new Promise((resolveRun) => {
      let stdout = '';
      let settled = false;
      const settle = (result: AntigravityCommandResult): void => {
        if (!settled) {
          settled = true;
          resolveRun(result);
        }
      };
      const child = spawn(command, arguments_, { stdio: ['ignore', 'pipe', 'ignore'] });
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.once('error', (error: NodeJS.ErrnoException) => settle({ status: error.code === 'ENOENT' ? 'not_found' : 'failed_to_start' }));
      child.once('close', (exitCode) => settle({ status: 'completed', exitCode, stdout }));
    });
  }
}
