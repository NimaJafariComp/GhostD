import { randomUUID } from 'node:crypto';

import { GHOST_EVENT_SCHEMA_VERSION, deriveTrustClass } from '../../core/events.js';
import type { GhostEvent, GhostEventType, WorkspaceState } from '../../core/events.js';
import { snapshotWorkspace } from '../../workspace/git.js';
import type { SourceAdapter } from '../source.js';

type GeminiHookInput = Record<string, unknown>;
type WorkspaceSnapshotter = (cwd: string) => WorkspaceState;

function stringValue(input: GeminiHookInput, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function canonicalType(input: GeminiHookInput): GhostEventType | undefined {
  const name = stringValue(input, 'hook_event_name', 'event_name', 'eventName', 'type')
    ?.replaceAll(/[-_\s]/g, '')
    .toLowerCase();
  switch (name) {
    case 'sessionstart': return 'session_start';
    case 'sessionend': return 'session_end';
    case 'userpromptsubmit':
    case 'usermessage':
    case 'beforeagent': return 'user_message';
    case 'assistantmessage':
    case 'modelresponse':
    case 'afteragent': return 'assistant_message';
    case 'pretooluse':
    case 'beforetool': return 'tool_call';
    case 'posttooluse':
    case 'aftertool': return 'tool_result';
    case 'stop':
    case 'precompress': return 'turn_end';
    default: return undefined;
  }
}

function eventPayload(input: GeminiHookInput, type: GhostEventType): Record<string, unknown> {
  const temporal = input['temporal'];
  const temporalPayload = isRecord(temporal) ? { temporal } : {};
  const text = stringValue(input, 'prompt', 'message', 'text', 'content', 'prompt_response');
  switch (type) {
    case 'user_message':
    case 'assistant_message':
      return { text: text ?? '[Gemini message content unavailable]', ...temporalPayload };
    case 'tool_call':
      return {
        tool: stringValue(input, 'tool_name', 'toolName', 'tool') ?? 'unknown',
        ...(input['tool_input'] === undefined ? {} : { input: input['tool_input'] }),
        ...temporalPayload,
      };
    case 'tool_result':
      return {
        tool: stringValue(input, 'tool_name', 'toolName', 'tool') ?? 'unknown',
        ...(input['tool_response'] === undefined ? {} : { output: input['tool_response'] }),
        ...temporalPayload,
      };
    default:
      return { geminiEvent: type, ...temporalPayload };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Normalizes Gemini hook-shaped input without reading a transcript or hidden provider state. */
export class GeminiSourceAdapter implements SourceAdapter<GeminiHookInput> {
  public readonly name = 'gemini';

  public constructor(
    private readonly workspaceSnapshotter: WorkspaceSnapshotter = snapshotWorkspace,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly id: () => string = randomUUID,
  ) {}

  public normalize(input: GeminiHookInput): GhostEvent[] {
    const type = canonicalType(input);
    if (type === undefined) {
      return [];
    }
    const sessionId = stringValue(input, 'session_id', 'sessionId', 'conversation_id', 'conversationId');
    if (sessionId === undefined) {
      throw new Error('Gemini hook input is missing session_id.');
    }
    const cwd = stringValue(input, 'cwd', 'working_directory', 'workingDirectory') ?? process.cwd();
    const timestamp = stringValue(input, 'timestamp', 'occurred_at', 'occurredAt') ?? this.now();
    const eventId = stringValue(input, 'hook_run_id', 'event_id', 'eventId') ?? this.id();
    return [{
      schemaVersion: GHOST_EVENT_SCHEMA_VERSION,
      id: `gemini-${sessionId}-${eventId}`,
      sessionId,
      timestamp,
      source: 'gemini',
      type,
      trustClass: deriveTrustClass(type),
      payload: eventPayload(input, type),
      workspace: this.workspaceSnapshotter(cwd),
    }];
  }
}
