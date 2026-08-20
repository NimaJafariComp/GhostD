import { spawn } from 'node:child_process';

export const providerCliNames = ['codex', 'claude', 'gemini', 'antigravity'] as const;

export type ProviderCliName = typeof providerCliNames[number];

interface ProviderCliDefinition {
  displayName: string;
  executable: string;
  packageName?: string;
}

const providerCliDefinitions: Record<ProviderCliName, ProviderCliDefinition> = {
  codex: {
    displayName: 'Codex',
    executable: 'codex',
    packageName: '@openai/codex',
  },
  claude: {
    displayName: 'Claude Code',
    executable: 'claude',
    packageName: '@anthropic-ai/claude-code',
  },
  gemini: {
    displayName: 'Gemini CLI',
    executable: 'gemini',
    packageName: '@google/gemini-cli',
  },
  antigravity: {
    displayName: 'Google Antigravity CLI',
    executable: 'agy',
  },
};

export interface CommandRunner {
  run(command: string, arguments_: readonly string[]): Promise<CommandResult>;
}

export type CommandResult =
  | { status: 'completed'; exitCode: number | null; stdout: string }
  | { status: 'not_found' }
  | { status: 'failed_to_start' };

export interface ProviderCliStatus {
  provider: ProviderCliName;
  displayName: string;
  executable: string;
  packageName?: string;
  installed: boolean;
  version?: string;
}

export class ProviderCliInstallError extends Error {
  public constructor(provider: ProviderCliName, reason: 'npm_missing' | 'install_failed' | 'not_detected_after_install' | 'manual_install_required') {
    const detail = reason === 'npm_missing'
      ? 'npm is required to install provider CLIs.'
      : reason === 'install_failed'
        ? 'The official package installer exited unsuccessfully.'
        : reason === 'manual_install_required'
          ? 'This provider requires its official installer; GhostD will not guess or run an unverified install command.'
          : 'The provider CLI was not found after installation.';
    super(`Could not install ${providerCliDefinitions[provider].displayName}: ${detail}`);
    this.name = 'ProviderCliInstallError';
  }
}

export class ProviderCliManager {
  public constructor(private readonly runner: CommandRunner = new ChildProcessCommandRunner()) {}

  public async status(provider: ProviderCliName): Promise<ProviderCliStatus> {
    const definition = providerCliDefinitions[provider];
    const result = await this.runner.run(definition.executable, ['--version']);
    if (result.status === 'not_found') {
      return {
        provider,
        displayName: definition.displayName,
        executable: definition.executable,
        ...(definition.packageName === undefined ? {} : { packageName: definition.packageName }),
        installed: false,
      };
    }

    return {
      provider,
      displayName: definition.displayName,
      executable: definition.executable,
      ...(definition.packageName === undefined ? {} : { packageName: definition.packageName }),
      installed: true,
      ...(result.status === 'completed' && result.exitCode === 0 && result.stdout.trim().length > 0
        ? { version: result.stdout.trim().split(/\r?\n/, 1)[0] }
        : {}),
    };
  }

  public async statuses(): Promise<ProviderCliStatus[]> {
    return Promise.all(providerCliNames.map((provider) => this.status(provider)));
  }

  public async install(provider: ProviderCliName): Promise<ProviderCliStatus> {
    const existing = await this.status(provider);
    if (existing.installed) {
      return existing;
    }

    if (existing.packageName === undefined) {
      throw new ProviderCliInstallError(provider, 'manual_install_required');
    }
    const installation = await this.runner.run('npm', ['install', '--global', existing.packageName]);
    if (installation.status === 'not_found') {
      throw new ProviderCliInstallError(provider, 'npm_missing');
    }
    if (installation.status !== 'completed' || installation.exitCode !== 0) {
      throw new ProviderCliInstallError(provider, 'install_failed');
    }

    const installed = await this.status(provider);
    if (!installed.installed) {
      throw new ProviderCliInstallError(provider, 'not_detected_after_install');
    }
    return installed;
  }

  public async installMissing(): Promise<ProviderCliStatus[]> {
    const statuses = await this.statuses();
    const installed: ProviderCliStatus[] = [];
    for (const status of statuses) {
      installed.push(status.installed ? status : await this.install(status.provider));
    }
    return installed;
  }
}

class ChildProcessCommandRunner implements CommandRunner {
  public async run(command: string, arguments_: readonly string[]): Promise<CommandResult> {
    return new Promise((resolve) => {
      let stdout = '';
      let settled = false;
      const finish = (result: CommandResult): void => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };
      const child = spawn(command, arguments_, { stdio: ['ignore', 'pipe', 'ignore'] });
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.once('error', (error: NodeJS.ErrnoException) => {
        finish({ status: error.code === 'ENOENT' ? 'not_found' : 'failed_to_start' });
      });
      child.once('close', (exitCode) => {
        finish({ status: 'completed', exitCode, stdout });
      });
    });
  }
}
