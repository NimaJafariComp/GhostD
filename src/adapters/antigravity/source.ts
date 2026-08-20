import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';

import { GHOST_EVENT_SCHEMA_VERSION, deriveTrustClass } from '../../core/events.js';
import type { GhostEvent, GhostEventType, WorkspaceState } from '../../core/events.js';
import { snapshotWorkspace } from '../../workspace/git.js';
import type { SourceAdapter } from '../source.js';

export const antigravityHookEvents = ['PreInvocation', 'PostInvocation', 'PostToolUse', 'Stop'] as const;
export type AntigravityHookEvent = (typeof antigravityHookEvents)[number];

type AntigravityHookInput = Record<string, unknown>;
type WorkspaceSnapshotter = (cwd: string) => WorkspaceState;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(input: AntigravityHookInput, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function numberValue(input: AntigravityHookInput, key: string): number | undefined {
  const value = input[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function workspacePaths(input: AntigravityHookInput): string[] {
  const value = input['workspacePaths'];
  if (!Array.isArray(value)) throw new Error('Antigravity hook input is missing workspacePaths.');
  const paths = [...new Set(value.filter((path): path is string => typeof path === 'string' && path.trim().length > 0).map((path) => path.trim()))];
  if (paths.length === 0 || paths.some((path) => !isAbsolute(path))) {
    throw new Error('Antigravity hook input must provide absolute workspacePaths.');
  }
  return paths;
}

function canonicalType(input: AntigravityHookInput): GhostEventType | undefined {
  switch (stringValue(input, 'hookEventName')) {
    case 'PreInvocation': return 'session_start';
    case 'PostInvocation': return 'turn_end';
    case 'PostToolUse': return 'tool_result';
    case 'Stop': return input['fullyIdle'] === false ? 'turn_end' : 'session_end';
    default: return undefined;
  }
}

function payload(input: AntigravityHookInput, type: GhostEventType): Record<string, unknown> {
  const event = stringValue(input, 'hookEventName') ?? 'unknown';
  const invocationNumber = numberValue(input, 'invocationNum');
  switch (type) {
    case 'tool_result': {
      const toolCall = isRecord(input['toolCall']) ? input['toolCall'] : {};
      const error = stringValue(input, 'error');
      return {
        antigravityEvent: event,
        tool: stringValue(toolCall, 'name') ?? 'unknown',
        ...(toolCall['args'] === undefined ? {} : { input: toolCall['args'] }),
        ...(error === undefined ? {} : { output: error }),
      };
    }
    case 'session_end':
      return {
        antigravityEvent: event,
        reason: stringValue(input, 'terminationReason') ?? 'stopped',
        ...(stringValue(input, 'error') === undefined ? {} : { error: stringValue(input, 'error') }),
        fullyIdle: true,
      };
    default:
      return {
        antigravityEvent: event,
        ...(invocationNumber === undefined ? {} : { invocationNumber }),
        ...(numberValue(input, 'initialNumSteps') === undefined ? {} : { initialNumSteps: numberValue(input, 'initialNumSteps') }),
        ...(input['fullyIdle'] === false ? { fullyIdle: false } : {}),
      };
  }
}

function eventSuffix(input: AntigravityHookInput, type: GhostEventType, fallback: () => string): string {
  const name = stringValue(input, 'hookEventName') ?? type;
  const sequence = numberValue(input, 'stepIdx') ?? numberValue(input, 'invocationNum') ?? numberValue(input, 'executionNum');
  return sequence === undefined ? `${name}-${fallback()}` : `${name}-${sequence}`;
}

/** Normalizes only documented Antigravity hook data and never reads its transcript or artifact directories. */
export class AntigravitySourceAdapter implements SourceAdapter<AntigravityHookInput> {
  public readonly name = 'antigravity';

  public constructor(
    private readonly workspaceSnapshotter: WorkspaceSnapshotter = snapshotWorkspace,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly id: () => string = randomUUID,
  ) {}

  public normalize(input: AntigravityHookInput): GhostEvent[] {
    const type = canonicalType(input);
    if (type === undefined) return [];
    const sessionId = stringValue(input, 'conversationId');
    if (sessionId === undefined) throw new Error('Antigravity hook input is missing conversationId.');
    const timestamp = stringValue(input, 'timestamp', 'occurredAt') ?? this.now();
    const suffix = eventSuffix(input, type, this.id);
    return workspacePaths(input).map((cwd) => ({
      schemaVersion: GHOST_EVENT_SCHEMA_VERSION,
      id: `antigravity-${sessionId}-${cwd.replaceAll(/[^a-zA-Z0-9]/g, '_')}-${suffix}`,
      sessionId,
      timestamp,
      source: 'antigravity',
      type,
      trustClass: deriveTrustClass(type),
      payload: payload(input, type),
      workspace: this.workspaceSnapshotter(cwd),
    }));
  }
}
