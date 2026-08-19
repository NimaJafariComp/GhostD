import { randomUUID } from 'node:crypto';

import { GHOST_EVENT_SCHEMA_VERSION, deriveTrustClass } from '../../core/events.js';
import type { GhostEvent, GhostEventType, WorkspaceState } from '../../core/events.js';
import { snapshotWorkspace } from '../../workspace/git.js';
import type { SourceAdapter } from '../source.js';

type ClaudeHookInput = Record<string, unknown>;
type WorkspaceSnapshotter = (cwd: string) => WorkspaceState;

function stringValue(input: ClaudeHookInput, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function normalizedEventName(input: ClaudeHookInput): string | undefined {
  return stringValue(input, 'hook_event_name', 'event_name', 'eventName', 'type')
    ?.replaceAll(/[-_\s]/g, '')
    .toLowerCase();
}

function canonicalType(name: string): GhostEventType | undefined {
  switch (name) {
    case 'sessionstart': return 'session_start';
    case 'sessionend': return 'session_end';
    case 'userpromptsubmit':
    case 'usermessage': return 'user_message';
    case 'assistantmessage': return 'assistant_message';
    case 'pretooluse': return 'tool_call';
    case 'posttooluse': return 'tool_result';
    case 'stop': return 'turn_end';
    default: return undefined;
  }
}

function payload(input: ClaudeHookInput, type: GhostEventType): Record<string, unknown> {
  const temporal = input['temporal'];
  const text = stringValue(input, 'prompt', 'message', 'text', 'content');
  switch (type) {
    case 'user_message':
    case 'assistant_message':
      return { text: text ?? '[Claude message content unavailable]', ...(isRecord(temporal) ? { temporal } : {}) };
    case 'tool_call':
      return {
        tool: stringValue(input, 'tool_name', 'toolName', 'tool') ?? 'unknown',
        ...(input['tool_input'] === undefined ? {} : { input: input['tool_input'] }),
        ...(isRecord(temporal) ? { temporal } : {}),
      };
    case 'tool_result':
      return {
        tool: stringValue(input, 'tool_name', 'toolName', 'tool') ?? 'unknown',
        ...(input['tool_response'] === undefined ? {} : { output: input['tool_response'] }),
        ...(isRecord(temporal) ? { temporal } : {}),
      };
    default:
      return { claudeEvent: type, ...(isRecord(temporal) ? { temporal } : {}) };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Normalizes Claude hook-shaped input without reading a Claude transcript or hidden state. */
export class ClaudeSourceAdapter implements SourceAdapter<ClaudeHookInput> {
  public readonly name = 'claude';

  public constructor(
    private readonly workspaceSnapshotter: WorkspaceSnapshotter = snapshotWorkspace,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly id: () => string = randomUUID,
  ) {}

  public normalize(input: ClaudeHookInput): GhostEvent[] {
    const name = normalizedEventName(input);
    if (name === undefined) {
      throw new Error('Claude hook input is missing an event name.');
    }
    const type = canonicalType(name);
    if (type === undefined) {
      return [];
    }
    const sessionId = stringValue(input, 'session_id', 'sessionId', 'conversation_id', 'conversationId');
    if (sessionId === undefined) {
      throw new Error('Claude hook input is missing session_id.');
    }
    const cwd = stringValue(input, 'cwd', 'working_directory', 'workingDirectory') ?? process.cwd();
    const timestamp = stringValue(input, 'timestamp', 'occurred_at', 'occurredAt') ?? this.now();
    const eventId = stringValue(input, 'hook_run_id', 'event_id', 'eventId') ?? this.id();
    return [{
      schemaVersion: GHOST_EVENT_SCHEMA_VERSION,
      id: `claude-${sessionId}-${eventId}`,
      sessionId,
      timestamp,
      source: 'claude',
      type,
      trustClass: deriveTrustClass(type),
      payload: payload(input, type),
      workspace: this.workspaceSnapshotter(cwd),
    }];
  }
}
