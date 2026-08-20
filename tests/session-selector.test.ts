import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveSessionChoice, sessionChoices } from '../src/cli/session-selector.js';
import type { GhostEvent } from '../src/core/events.js';
import { GhostDatabase } from '../src/db/database.js';

const temporaryDirectories: string[] = [];
const workspace = '/work/ghost';

afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true }))));

async function openDatabase(): Promise<GhostDatabase> {
  const directory = await mkdtemp(join(tmpdir(), 'ghostd-session-selector-'));
  temporaryDirectories.push(directory);
  return GhostDatabase.open(join(directory, 'ghost.db'));
}

function event(id: string, sessionId: string, timestamp: string, text: string): GhostEvent {
  return {
    schemaVersion: 1,
    id,
    sessionId,
    timestamp,
    source: sessionId.startsWith('claude') ? 'claude' : 'codex',
    type: 'user_message',
    trustClass: 'user',
    payload: { text },
    workspace: { cwd: workspace },
  };
}

describe('human-readable Ghost session selection', () => {
  it('assigns stable workspace-local numbers by retained creation order, not mutable activity order', async () => {
    const database = await openDatabase();
    try {
      database.append(event('codex-first', 'codex-session', '2026-08-20T12:00:00.000Z', 'Implement green mode instead.'));
      database.append(event('claude-second', 'claude-session', '2026-08-20T12:01:00.000Z', 'Review the authentication regression.'));
      database.append(event('codex-later', 'codex-session', '2026-08-20T12:02:00.000Z', 'Green mode remains the objective.'));

      const choices = sessionChoices(database, workspace);
      expect(choices.map(({ index, session }) => [index, session.sourceSessionId])).toEqual([
        [1, 'codex-session'],
        [2, 'claude-session'],
      ]);
      expect(choices[0]?.label).toBe('Green mode remains the objective.');
    } finally {
      database.close();
    }
  });

  it('selects a listed number or full Ghost ID, but never a provider session identifier', async () => {
    const database = await openDatabase();
    try {
      database.append(event('codex', 'codex-session', '2026-08-20T12:00:00.000Z', 'Implement green mode instead.'));
      const choices = sessionChoices(database, workspace);
      const choice = choices[0];
      expect(choice).toBeDefined();
      expect(resolveSessionChoice(choices, '1').session.id).toBe(choice?.session.id);
      expect(resolveSessionChoice(choices, choice?.session.id ?? '').index).toBe(1);
      expect(() => resolveSessionChoice(choices, 'codex-session')).toThrow('is not listed');
      expect(() => resolveSessionChoice(choices, '2')).toThrow('Session number 2 is not listed');
    } finally {
      database.close();
    }
  });

  it('derives labels from redacted canonical context rather than a host chat title', async () => {
    const database = await openDatabase();
    try {
      database.append(event('secret', 'codex-session', '2026-08-20T12:00:00.000Z', 'Investigate Authorization: Bearer super-secret-value.'));
      const label = sessionChoices(database, workspace)[0]?.label;
      expect(label).toContain('[REDACTED]');
      expect(label).not.toContain('super-secret-value');
    } finally {
      database.close();
    }
  });
});
