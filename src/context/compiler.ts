import { basename } from 'node:path';

import type { StoredEvent } from '../db/database.js';
import type { TrustClass } from '../core/events.js';

const MAX_RECENT_MESSAGES = 8;
const MAX_RECENT_FAILURES = 5;
const MAX_RECENT_DECISIONS = 5;

export interface EventRef {
  eventId: string;
  sequence: number;
  type: StoredEvent['type'];
  trustClass: TrustClass;
}

export interface ContextFact {
  value: string;
  sources: EventRef[];
}

export interface CompiledContext {
  project: string;
  agent: string;
  sessionId: string;
  currentObjective: ContextFact;
  userRequirements: ContextFact[];
  importantDecisions: ContextFact[];
  modifiedFiles: ContextFact[];
  recentFailures: ContextFact[];
  recentConversation: ContextFact[];
  workspace: {
    cwd: string;
    gitHead?: string;
    dirty?: boolean;
    source: EventRef;
  };
}

function stringField(payload: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = payload[name];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function recent<T>(values: T[], limit: number): T[] {
  return values.slice(Math.max(values.length - limit, 0));
}

function eventRef(event: StoredEvent): EventRef {
  return { eventId: event.id, sequence: event.sequence, type: event.type, trustClass: event.trustClass };
}

function facts(candidates: Array<{ value: string; event: StoredEvent }>): ContextFact[] {
  const byValue = new Map<string, ContextFact>();
  for (const { value, event } of candidates) {
    const existing = byValue.get(value);
    if (existing === undefined) {
      byValue.set(value, { value, sources: [eventRef(event)] });
    } else {
      existing.sources.push(eventRef(event));
    }
  }
  return [...byValue.values()];
}

function eventText(event: StoredEvent, ...names: string[]): string | undefined {
  return stringField(event.payload, ...names);
}

function isRequirement(text: string): boolean {
  return /\b(must|must not|don't|do not|never|only|avoid|without|require)\b/i.test(text);
}

function isDecision(text: string): boolean {
  return /\b(decided|decision|choose|chose|using|use|will use|settled)\b/i.test(text);
}

function isFailure(text: string): boolean {
  return /\b(fail(?:ed|ing)?|error|exception|panic|exit code [1-9]|flaky)\b/i.test(text);
}

export function compileContext(events: StoredEvent[]): CompiledContext {
  const latest = events.at(-1);
  if (latest === undefined) {
    throw new Error('Cannot compile context for an empty session.');
  }

  const userMessages = events
    .filter((event) => event.type === 'user_message')
    .flatMap((event) => {
      const value = eventText(event, 'text', 'message');
      return value === undefined ? [] : [{ value, event }];
    });
  const assistantMessages = events
    .filter((event) => event.type === 'assistant_message')
    .flatMap((event) => {
      const value = eventText(event, 'text', 'message');
      return value === undefined ? [] : [{ value, event }];
    });
  const toolResults = events
    .filter((event) => event.type === 'tool_result')
    .flatMap((event) => {
      const value = eventText(event, 'output', 'text', 'message');
      return value === undefined ? [] : [{ value, event }];
    });
  const changedFiles = events
    .filter((event) => event.type === 'file_change')
    .flatMap((event) => {
      const value = eventText(event, 'path', 'file');
      return value === undefined ? [] : [{ value, event }];
    });

  const objectiveCandidate = userMessages.at(-1);
  const objective: ContextFact =
    objectiveCandidate === undefined
      ? { value: 'No user objective has been captured yet.', sources: [] }
      : { value: objectiveCandidate.value, sources: [eventRef(objectiveCandidate.event)] };
  const requirements = facts([...userMessages, ...assistantMessages].filter(({ value }) => isRequirement(value)));
  const decisions = facts(assistantMessages.filter(({ value }) => isDecision(value)));
  const failures = facts(toolResults.filter(({ value }) => isFailure(value)));
  const recentConversation = recent(
    events
      .filter((event) => event.type === 'user_message' || event.type === 'assistant_message')
      .flatMap((event) => {
        const text = eventText(event, 'text', 'message');
        if (text === undefined) {
          return [];
        }
        const speaker = event.type === 'user_message' ? 'User' : 'Assistant';
        return [{ value: `${speaker}: ${text}`, event }];
      })
      .map(({ value, event }) => ({ value, sources: [eventRef(event)] })),
    MAX_RECENT_MESSAGES,
  );

  const gitStatus = latest.workspace.gitStatus;
  const dirty = gitStatus === undefined ? undefined : gitStatus.trim().length > 0;
  const context: CompiledContext = {
    project: basename(latest.workspace.cwd),
    agent: latest.source,
    sessionId: latest.sessionId,
    currentObjective: objective,
    userRequirements: recent(requirements, MAX_RECENT_MESSAGES),
    importantDecisions: recent(decisions, MAX_RECENT_DECISIONS),
    modifiedFiles: facts(changedFiles),
    recentFailures: recent(failures, MAX_RECENT_FAILURES),
    recentConversation,
    workspace: {
      cwd: latest.workspace.cwd,
      ...(latest.workspace.gitHead === undefined ? {} : { gitHead: latest.workspace.gitHead }),
      ...(dirty === undefined ? {} : { dirty }),
      source: eventRef(latest),
    },
  };

  return context;
}

function formatFact(fact: ContextFact, includeProvenance: boolean): string {
  if (!includeProvenance || fact.sources.length === 0) {
    return fact.value;
  }
  const sourceIds = fact.sources.map(({ eventId }) => eventId).join(', ');
  return `${fact.value} [from: ${sourceIds}]`;
}

function formatList(items: ContextFact[], empty: string, includeProvenance: boolean): string[] {
  return items.length === 0 ? [`- ${empty}`] : items.map((item) => `- ${formatFact(item, includeProvenance)}`);
}

export function renderContext(context: CompiledContext, includeProvenance = false): string {
  const gitHead = context.workspace.gitHead ?? 'unknown';
  const dirty = context.workspace.dirty === true ? 'yes' : context.workspace.dirty === false ? 'no' : 'unknown';

  return [
    `Project: ${context.project}`,
    `Agent: ${context.agent}`,
    `Session: ${context.sessionId}`,
    '',
    'CURRENT OBJECTIVE',
    formatFact(context.currentObjective, includeProvenance),
    '',
    'USER REQUIREMENTS',
    ...formatList(context.userRequirements, 'None captured.', includeProvenance),
    '',
    'IMPORTANT DECISIONS',
    ...formatList(context.importantDecisions, 'None captured.', includeProvenance),
    '',
    'MODIFIED FILES',
    ...formatList(context.modifiedFiles, 'None captured.', includeProvenance),
    '',
    'RECENT FAILURES',
    ...formatList(context.recentFailures, 'None captured.', includeProvenance),
    '',
    'WORKSPACE',
    `cwd: ${context.workspace.cwd}`,
    `git HEAD: ${gitHead}`,
    `dirty: ${dirty}`,
    ...(includeProvenance ? [`from: ${context.workspace.source.eventId}`] : []),
    '',
    'RECENT CONVERSATION',
    ...formatList(context.recentConversation, 'None captured.', includeProvenance),
  ].join('\n');
}
