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
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const hooks = (value as Record<string, unknown>)['hooks'];
  if (hooks === undefined) {
    return true;
  }
  return typeof hooks === 'object' && hooks !== null && !Array.isArray(hooks)
    && Object.values(hooks).every((groups) => Array.isArray(groups) && groups.every(isHookGroup));
}

function isHookGroup(value: unknown): value is HookGroup {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const group = value as Record<string, unknown>;
  return (group['matcher'] === undefined || typeof group['matcher'] === 'string')
    && Array.isArray(group['hooks'])
    && group['hooks'].every(isHookHandler);
}

function isHookHandler(value: unknown): value is HookHandler {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const handler = value as Record<string, unknown>;
  return handler['type'] === 'command' && typeof handler['command'] === 'string';
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

export async function codexHooksInstalled(workspace: string, ghostCommand: string): Promise<boolean> {
  const path = join(workspace, '.codex', 'hooks.json');
  let config: HookConfig;
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (!isHookConfig(parsed)) {
      throw new Error('Codex hooks configuration must be a JSON object.');
    }
    config = parsed;
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
  return codexHookEvents.some((eventName) => (config.hooks?.[eventName] ?? [])
    .some(({ hooks }) => hooks.some(({ type, command }) => type === 'command' && command === ghostCommand)));
}

/** Removes only Ghost's exact command; shared hook configuration and feature flags remain untouched. */
export async function removeCodexHooks(workspace: string, ghostCommand: string): Promise<boolean> {
  const path = join(workspace, '.codex', 'hooks.json');
  let config: HookConfig;
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (!isHookConfig(parsed)) {
      throw new Error('Codex hooks configuration must be a JSON object.');
    }
    config = parsed;
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }

  let removed = false;
  for (const eventName of codexHookEvents) {
    const groups = config.hooks?.[eventName];
    if (groups === undefined) continue;
    const retained = groups
      .map((group) => {
        const hooks = group.hooks.filter((hook) => {
          const matches = hook.type === 'command' && hook.command === ghostCommand;
          removed ||= matches;
          return !matches;
        });
        return { ...group, hooks };
      })
      .filter(({ hooks }) => hooks.length > 0);
    if (config.hooks !== undefined) {
      config.hooks[eventName] = retained;
    }
  }
  if (removed) {
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  }
  return removed;
}

async function enableCodexHooks(configDirectory: string): Promise<void> {
  const configPath = join(configDirectory, 'config.toml');
  let config: string;
  try {
    config = await readFile(configPath, 'utf8');
  } catch (error: unknown) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
      throw error;
    }
    config = '';
  }

  const updated = enableFeature(config, 'hooks');
  if (updated !== config) {
    await writeFile(configPath, updated, 'utf8');
  }
}

function enableFeature(config: string, feature: string): string {
  const lines = config.split('\n');
  const section = lines.findIndex((line) => line.trim() === '[features]');
  if (section === -1) {
    const separator = config.length === 0 || config.endsWith('\n') ? '' : '\n';
    return `${config}${separator}[features]\n${feature} = true\n`;
  }

  let sectionEnd = lines.length;
  for (let index = section + 1; index < lines.length; index += 1) {
    if (/^\s*\[.+\]\s*$/.test(lines[index] ?? '')) {
      sectionEnd = index;
      break;
    }
  }
  const featureLine = new RegExp(`^(\\s*${feature}\\s*=\\s*)[^#\\s]+(\\s*(?:#.*)?)$`);
  for (let index = section + 1; index < sectionEnd; index += 1) {
    const line = lines[index];
    if (line !== undefined && featureLine.test(line)) {
      lines[index] = line.replace(featureLine, '$1true$2');
      return lines.join('\n');
    }
  }
  lines.splice(sectionEnd, 0, `${feature} = true`);
  return lines.join('\n');
}

export function hookCommand(nodePath: string, entryPath: string): string {
  return `${quote(nodePath)} ${quote(entryPath)} codex-hook`;
}
