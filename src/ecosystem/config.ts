import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const integrationProviders = ['codex', 'claude', 'gemini', 'antigravity'] as const;
export const providerModes = ['subscription', 'api'] as const;

export type IntegrationProvider = (typeof integrationProviders)[number];
export type ProviderMode = (typeof providerModes)[number];

export interface ProviderConfiguration {
  mode: ProviderMode;
  updatedAt: string;
}

export interface GhostConfiguration {
  version: 1;
  providers: Partial<Record<IntegrationProvider, ProviderConfiguration>>;
}

/** Stores non-secret integration intent only. Credentials remain in the provider CLI, OS keychain, or environment. */
export class IntegrationConfigStore {
  public constructor(private readonly path = process.env['GHOST_CONFIG_PATH'] ?? join(homedir(), '.ghost', 'config.json')) {}

  public async load(): Promise<GhostConfiguration> {
    try {
      return parseConfiguration(await readFile(this.path, 'utf8'));
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return { version: 1, providers: {} };
      }
      throw error;
    }
  }

  public async setProvider(provider: IntegrationProvider, mode: ProviderMode, updatedAt = new Date().toISOString()): Promise<GhostConfiguration> {
    const current = await this.load();
    const updated: GhostConfiguration = { ...current, providers: { ...current.providers, [provider]: { mode, updatedAt } } };
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, `${JSON.stringify(updated, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.path);
    return updated;
  }
}

function parseConfiguration(value: string): GhostConfiguration {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Ghost configuration must be a JSON object.');
  }
  const config = parsed as Record<string, unknown>;
  if (config['version'] !== 1 || typeof config['providers'] !== 'object' || config['providers'] === null || Array.isArray(config['providers'])) {
    throw new Error('Ghost configuration is invalid.');
  }
  const providers: GhostConfiguration['providers'] = {};
  for (const provider of integrationProviders) {
    const valueForProvider = (config['providers'] as Record<string, unknown>)[provider];
    if (valueForProvider === undefined) continue;
    if (typeof valueForProvider !== 'object' || valueForProvider === null || Array.isArray(valueForProvider)) throw new Error('Ghost configuration is invalid.');
    const entry = valueForProvider as Record<string, unknown>;
    if (!providerModes.includes(entry['mode'] as ProviderMode) || typeof entry['updatedAt'] !== 'string') throw new Error('Ghost configuration is invalid.');
    providers[provider] = { mode: entry['mode'] as ProviderMode, updatedAt: entry['updatedAt'] };
  }
  return { version: 1, providers };
}
