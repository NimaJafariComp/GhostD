import { randomUUID } from 'node:crypto';

import { GHOST_EVENT_SCHEMA_VERSION, deriveTrustClass } from '../../core/events.js';
import type { GhostEvent, GhostEventType, WorkspaceState } from '../../core/events.js';
import { snapshotWorkspace } from '../../workspace/git.js';
import type { SourceAdapter } from '../source.js';

type CodexHookInput = Record<string, unknown>;
type WorkspaceSnapshotter = (cwd: string) => WorkspaceState;

function stringValue(input: CodexHookInput, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function payloadValue(value: unknown): string | Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function normalizedEventName(input: CodexHookInput): string | undefined {
  const name = stringValue(input, 'hook_event_name', 'event_name', 'eventName');
  return name?.replaceAll(/[-_\s]/g, '').toLowerCase();
}

function canonicalType(name: string): GhostEventType | undefined {
  switch (name) {
    case 'sessionstart': return 'session_start';
    case 'sessionend': return 'session_end';
    case 'userpromptsubmit': return 'user_message';
    case 'pretooluse':
    case 'subagentstart': return 'tool_call';
    case 'posttooluse':
    case 'subagentstop': return 'tool_result';
    case 'stop':
    case 'precompact':
    case 'postcompact': return 'turn_end';
    default: return undefined;
  }
}

function changedFiles(status: string | undefined): string[] {
  if (status === undefined) {
    return [];
  }
  return status
    .split(/\r?\n/)
    .map((line) => line.length >= 4 ? line.slice(3).trim() : '')
    .filter((path) => path.length > 0);
}

function eventPayload(name: string, input: CodexHookInput): Record<string, unknown> {
  switch (name) {
    case 'userpromptsubmit':
      return { text: stringValue(input, 'prompt', 'user_prompt', 'message', 'input') ?? '[User prompt content unavailable]' };
    case 'pretooluse':
      return {
        tool: stringValue(input, 'tool_name', 'toolName') ?? 'unknown',
        ...(payloadValue(input['tool_input'] ?? input['toolInput']) === undefined ? {} : { input: payloadValue(input['tool_input'] ?? input['toolInput']) }),
      };
    case 'posttooluse':
      return {
        tool: stringValue(input, 'tool_name', 'toolName') ?? 'unknown',
        ...(payloadValue(input['tool_response'] ?? input['toolResponse']) === undefined ? {} : { output: payloadValue(input['tool_response'] ?? input['toolResponse']) }),
      };
    case 'stop':
      return { reason: stringValue(input, 'stop_reason', 'stopReason') ?? 'completed' };
    default:
      return { codexEvent: name };
  }
}

/** Normalizes Codex hook input; it deliberately never reads transcript files. */
export class CodexAdapter implements SourceAdapter<CodexHookInput> {
  public readonly name = 'codex';

  public constructor(
    private readonly workspaceSnapshotter: WorkspaceSnapshotter = snapshotWorkspace,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly id: () => string = randomUUID,
  ) {}

  public normalize(input: CodexHookInput): GhostEvent[] {
    const name = normalizedEventName(input);
    if (name === undefined) {
      throw new Error('Codex hook input is missing hook_event_name.');
    }
    const type = canonicalType(name);
    if (type === undefined) {
      return [];
    }
    const sessionId = stringValue(input, 'session_id', 'sessionId');
    if (sessionId === undefined) {
      throw new Error('Codex hook input is missing session_id.');
    }
    const cwd = stringValue(input, 'cwd', 'working_directory', 'workingDirectory') ?? process.cwd();
    const workspace = this.workspaceSnapshotter(cwd);
    const timestamp = stringValue(input, 'timestamp', 'occurred_at', 'occurredAt') ?? this.now();
    const baseId = stringValue(input, 'hook_run_id', 'event_id', 'eventId') ?? this.id();
    const event = (id: string, eventType: GhostEventType, payload: Record<string, unknown>): GhostEvent => ({
      schemaVersion: GHOST_EVENT_SCHEMA_VERSION,
      id: `codex-${sessionId}-${baseId}-${id}`,
      sessionId,
      timestamp,
      source: 'codex',
      type: eventType,
      trustClass: deriveTrustClass(eventType),
      payload,
      workspace,
    });

    const events = [event('primary', type, eventPayload(name, input))];
    const assistantMessage = name === 'stop'
      ? stringValue(input, 'last_assistant_message', 'lastAssistantMessage', 'assistant_message')
      : undefined;
    if (assistantMessage !== undefined) {
      events.unshift(event('assistant', 'assistant_message', { text: assistantMessage }));
    }
    for (const [index, path] of changedFiles(workspace.gitStatus).entries()) {
      events.push(event(`file-${index}`, 'file_change', { path }));
    }
    return events;
  }
}
