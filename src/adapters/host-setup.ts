import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { codexHooksInstalled, installCodexHooks, removeCodexHooks } from './codex/setup.js';

export const capturableHosts = ['codex', 'claude', 'gemini'] as const;
export const unsupportedCaptureHosts = ['antigravity'] as const;

export type CapturableHost = (typeof capturableHosts)[number];
export type UnsupportedCaptureHost = (typeof unsupportedCaptureHosts)[number];
export type CaptureHost = CapturableHost | UnsupportedCaptureHost;

export interface HostCaptureStatus {
  host: CaptureHost;
  captureSupported: boolean;
  configured: boolean;
  configPath?: string;
  reason?: string;
}

interface HookHandler {
  type: string;
  command?: string;
  [key: string]: unknown;
}

interface HookGroup {
  hooks: HookHandler[];
  [key: string]: unknown;
}

interface HookConfiguration {
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
}

/** Documented Claude lifecycle events captured by both project hooks and the distributable plugin. */
export const claudeCaptureEvents = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'MessageDisplay', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'StopFailure', 'PreCompact', 'PostCompact'] as const;
const geminiEvents = ['SessionStart', 'SessionEnd', 'BeforeAgent', 'AfterAgent', 'BeforeTool', 'AfterTool', 'PreCompress'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHookHandler(value: unknown): value is HookHandler {
  return isRecord(value)
    && typeof value['type'] === 'string'
    && (value['command'] === undefined || typeof value['command'] === 'string');
}

function isHookGroup(value: unknown): value is HookGroup {
  return isRecord(value) && Array.isArray(value['hooks']) && value['hooks'].every(isHookHandler);
}

function isHookConfiguration(value: unknown): value is HookConfiguration {
  if (!isRecord(value) || value['hooks'] === undefined) return isRecord(value);
  return isRecord(value['hooks']) && Object.values(value['hooks']).every((groups) => Array.isArray(groups) && groups.every(isHookGroup));
}

function hostConfiguration(host: Exclude<CapturableHost, 'codex'>, workspace: string): { path: string; events: readonly string[] } {
  if (host === 'claude') {
    return { path: join(workspace, '.claude', 'settings.local.json'), events: claudeCaptureEvents };
  }
  return { path: join(workspace, '.gemini', 'settings.json'), events: geminiEvents };
}

async function readConfiguration(path: string): Promise<HookConfiguration | undefined> {
  try {
    const configuration = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (!isHookConfiguration(configuration)) {
      throw new Error(`Hook configuration at ${path} must be a JSON object with hook groups.`);
    }
    return configuration;
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function hasCommand(configuration: HookConfiguration, events: readonly string[], command: string): boolean {
  return events.some((event) => (configuration.hooks?.[event] ?? [])
    .some(({ hooks }) => hooks.some((hook) => hook.type === 'command' && hook.command === command)));
}

async function installJsonHooks(path: string, events: readonly string[], command: string): Promise<void> {
  const configuration = (await readConfiguration(path)) ?? {};
  const hooks = configuration.hooks ?? {};
  for (const event of events) {
    const groups = hooks[event] ?? [];
    const group = groups.find(({ matcher }) => matcher === undefined || matcher === '');
    if (group === undefined) {
      groups.push({ hooks: [{ type: 'command', command }] });
    } else if (!group.hooks.some((hook) => hook.type === 'command' && hook.command === command)) {
      group.hooks.push({ type: 'command', command });
    }
    hooks[event] = groups;
  }
  configuration.hooks = hooks;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(configuration, null, 2)}\n`, 'utf8');
}

async function removeJsonHooks(path: string, events: readonly string[], command: string): Promise<boolean> {
  const configuration = await readConfiguration(path);
  if (configuration === undefined || configuration.hooks === undefined) return false;
  let removed = false;
  for (const event of events) {
    const groups = configuration.hooks[event];
    if (groups === undefined) continue;
    configuration.hooks[event] = groups
      .map((group) => {
        const hooks = group.hooks.filter((hook) => {
          const matches = hook.type === 'command' && hook.command === command;
          removed ||= matches;
          return !matches;
        });
        return { ...group, hooks };
      })
      .filter(({ hooks }) => hooks.length > 0);
  }
  if (removed) {
    await writeFile(path, `${JSON.stringify(configuration, null, 2)}\n`, 'utf8');
  }
  return removed;
}

export async function hostCaptureStatus(host: CaptureHost, workspace: string, commands: Record<CapturableHost, string>): Promise<HostCaptureStatus> {
  if (host === 'antigravity') {
    return {
      host,
      captureSupported: false,
      configured: false,
      reason: 'No verified Antigravity source-capture contract is available.',
    };
  }
  if (host === 'codex') {
    return {
      host,
      captureSupported: true,
      configured: await codexHooksInstalled(workspace, commands.codex),
      configPath: join(workspace, '.codex', 'hooks.json'),
    };
  }
  const { path, events } = hostConfiguration(host, workspace);
  const configuration = await readConfiguration(path);
  return {
    host,
    captureSupported: true,
    configured: configuration === undefined ? false : hasCommand(configuration, events, commands[host]),
    configPath: path,
  };
}

/** Installs only the documented, project-scoped source hooks for an explicitly selected host. */
export async function installHostCapture(host: CapturableHost, workspace: string, commands: Record<CapturableHost, string>): Promise<string> {
  if (host === 'codex') return installCodexHooks(workspace, commands.codex);
  const { path, events } = hostConfiguration(host, workspace);
  await installJsonHooks(path, events, commands[host]);
  return path;
}

/** Removes only Ghost's exact command and never changes unrelated hooks or provider trust configuration. */
export async function removeHostCapture(host: CapturableHost, workspace: string, commands: Record<CapturableHost, string>): Promise<boolean> {
  if (host === 'codex') return removeCodexHooks(workspace, commands.codex);
  const { path, events } = hostConfiguration(host, workspace);
  return removeJsonHooks(path, events, commands[host]);
}
