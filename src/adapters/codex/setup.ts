import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const codexHookEvents = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'PreCompact',
  'PostCompact',
] as const;

interface HookHandler {
  type: 'command';
  command: string;
}

interface HookGroup {
  matcher?: string;
  hooks: HookHandler[];
}

interface HookConfig {
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
}

function isHookConfig(value: unknown): value is HookConfig {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function quote(argument: string): string {
  return `'${argument.replaceAll("'", "'\\''")}'`;
}

/** Adds Ghost's hook command without overwriting other project hook declarations. */
export async function installCodexHooks(workspace: string, ghostCommand: string): Promise<string> {
  const path = join(workspace, '.codex', 'hooks.json');
  let config: HookConfig = {};
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (!isHookConfig(parsed)) {
      throw new Error('Codex hooks configuration must be a JSON object.');
    }
    config = parsed;
  } catch (error: unknown) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
      throw error;
    }
  }

  const hooks = config.hooks ?? {};
  for (const eventName of codexHookEvents) {
    const groups = hooks[eventName] ?? [];
    const group = groups.find(({ matcher }) => matcher === '');
    if (group === undefined) {
      groups.push({ matcher: '', hooks: [{ type: 'command', command: ghostCommand }] });
    } else if (!group.hooks.some(({ type, command }) => type === 'command' && command === ghostCommand)) {
      group.hooks.push({ type: 'command', command: ghostCommand });
    }
    hooks[eventName] = groups;
  }

  config.hooks = hooks;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await enableCodexHooks(dirname(path));
  return path;
}

async function enableCodexHooks(configDirectory: string): Promise<void> {
  const configPath = join(configDirectory, 'config.toml');
  try {
    await readFile(configPath, 'utf8');
  } catch (error: unknown) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
      throw error;
    }
    await writeFile(configPath, '[features]\nhooks = true\n', 'utf8');
  }
}

export function hookCommand(nodePath: string, entryPath: string): string {
  return `${quote(nodePath)} ${quote(entryPath)} codex-hook`;
}
