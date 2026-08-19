export const ghostEventTypes = [
  'session_start',
  'user_message',
  'assistant_message',
  'tool_call',
  'tool_result',
  'file_change',
  'turn_end',
  'session_end',
] as const;

export const GHOST_EVENT_SCHEMA_VERSION = 1 as const;
export const trustClasses = ['user', 'agent', 'tool', 'workspace', 'external', 'system'] as const;

export type GhostEventType = (typeof ghostEventTypes)[number];
export type GhostSource = 'codex' | 'claude' | 'gemini' | (string & {});
export type TrustClass = (typeof trustClasses)[number];

export interface WorkspaceState {
  cwd: string;
  gitHead?: string;
  gitStatus?: string;
}

export interface GhostEvent {
  schemaVersion: typeof GHOST_EVENT_SCHEMA_VERSION;
  id: string;
  sessionId: string;
  timestamp: string;
  source: GhostSource;
  type: GhostEventType;
  trustClass: TrustClass;
  payload: Record<string, unknown>;
  workspace: WorkspaceState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Event field ${field} must be a non-empty string.`);
  }

  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new Error(`Event field ${field} must be a string.`);
  }

  return value;
}

export function deriveTrustClass(type: GhostEventType): TrustClass {
  switch (type) {
    case 'user_message':
      return 'user';
    case 'assistant_message':
      return 'agent';
    case 'session_start':
    case 'turn_end':
    case 'session_end':
      return 'system';
    case 'tool_call':
    case 'tool_result':
      return 'tool';
    case 'file_change':
      return 'workspace';
  }
}

function parseTrustClass(value: unknown): TrustClass {
  if (typeof value !== 'string' || !trustClasses.includes(value as TrustClass)) {
    throw new Error(`Unsupported Ghost trust class: ${String(value)}.`);
  }
  return value as TrustClass;
}

export function parseGhostEvent(value: unknown): GhostEvent {
  if (!isRecord(value)) {
    throw new Error('An event must be a JSON object.');
  }

  if (value['schemaVersion'] !== GHOST_EVENT_SCHEMA_VERSION) {
    throw new Error(`Unsupported Ghost event schema version: ${String(value['schemaVersion'])}.`);
  }

  const type = requiredString(value['type'], 'type');
  if (!ghostEventTypes.includes(type as GhostEventType)) {
    throw new Error(`Unsupported Ghost event type: ${type}.`);
  }

  const payload = value['payload'];
  if (!isRecord(payload)) {
    throw new Error('Event field payload must be a JSON object.');
  }

  const workspace = value['workspace'];
  if (!isRecord(workspace)) {
    throw new Error('Event field workspace must be a JSON object.');
  }

  const event: GhostEvent = {
    schemaVersion: GHOST_EVENT_SCHEMA_VERSION,
    id: requiredString(value['id'], 'id'),
    sessionId: requiredString(value['sessionId'], 'sessionId'),
    timestamp: requiredString(value['timestamp'], 'timestamp'),
    source: requiredString(value['source'], 'source'),
    type: type as GhostEventType,
    trustClass: parseTrustClass(value['trustClass']),
    payload,
    workspace: {
      cwd: requiredString(workspace['cwd'], 'workspace.cwd'),
    },
  };

  const gitHead = optionalString(workspace['gitHead'], 'workspace.gitHead');
  const gitStatus = optionalString(workspace['gitStatus'], 'workspace.gitStatus');
  if (gitHead !== undefined) {
    event.workspace.gitHead = gitHead;
  }
  if (gitStatus !== undefined) {
    event.workspace.gitStatus = gitStatus;
  }

  return event;
}
