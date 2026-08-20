import { compileContext } from '../context/compiler.js';
import type { CapturedSession, GhostDatabase } from '../db/database.js';
import { redactText } from '../privacy/redaction.js';

const NO_CAPTURED_OBJECTIVE = 'No user objective has been captured yet.';
const MAX_LABEL_LENGTH = 88;

export interface SessionChoice {
  index: number;
  session: CapturedSession;
  label: string;
}

function compactLabel(value: string): string {
  const normalized = redactText(value, 'storage').value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= MAX_LABEL_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_LABEL_LENGTH - 1).trimEnd()}…`;
}

function labelForSession(database: GhostDatabase, session: CapturedSession): string {
  const events = database.eventsForSession(session.id);
  if (events.length === 0) {
    return 'No captured context yet';
  }
  const objective = compileContext(events).currentObjective.value;
  return compactLabel(objective === NO_CAPTURED_OBJECTIVE ? 'No captured user objective yet' : objective);
}

/**
 * Numbers are stable for the lifetime of retained local history: sessions are
 * ordered by creation time rather than activity time, so a new hook event
 * cannot silently change the meaning of an already listed number.
 */
export function sessionChoices(database: GhostDatabase, workspaceCwd: string): SessionChoice[] {
  return database
    .sessions(workspaceCwd)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    .map((session, position) => ({ index: position + 1, session, label: labelForSession(database, session) }));
}

export function resolveSessionChoice(choices: readonly SessionChoice[], selection: string): SessionChoice {
  if (/^[1-9]\d*$/.test(selection)) {
    const choice = choices[Number.parseInt(selection, 10) - 1];
    if (choice !== undefined) {
      return choice;
    }
    throw new Error(`Session number ${selection} is not listed. Run ghost session list.`);
  }

  const choice = choices.find(({ session }) => session.id === selection);
  if (choice !== undefined) {
    return choice;
  }
  throw new Error(`Ghost session ${selection} is not listed. Run ghost session list.`);
}

export function describeSessionChoice(choice: SessionChoice): string {
  const state = choice.session.endedAt === undefined ? 'open' : `ended ${choice.session.endedAt}`;
  return `#${choice.index}  ${choice.session.source}  ${state}  “${choice.label}”`;
}
