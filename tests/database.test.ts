import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { GhostEvent } from '../src/core/events.js';
import { GhostDatabase } from '../src/db/database.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

function event(id: string, type: GhostEvent['type'] = 'user_message'): GhostEvent {
  return {
    schemaVersion: 1,
    id,
    sessionId: 'session-1',
    timestamp: '2026-08-19T12:00:00.000Z',
    source: 'codex',
    type,
    trustClass: type === 'user_message' ? 'user' : 'agent',
    payload: { text: 'Implement Ghost.' },
    workspace: { cwd: '/work/ghost', gitHead: 'abc123', gitStatus: '' },
  };
}

describe('GhostDatabase', () => {
  it('keeps the Ghost storage directory owner-only', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ghostd-private-storage-'));
    temporaryDirectories.push(directory);
    const storageDirectory = join(directory, 'ghost');
    const database = await GhostDatabase.open(join(storageDirectory, 'ghost.db'));

    try {
      expect((await stat(storageDirectory)).mode & 0o777).toBe(0o700);
    } finally {
      database.close();
    }
  });

  it('stores events in append-only session order', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ghostd-test-'));
    temporaryDirectories.push(directory);
    const database = await GhostDatabase.open(join(directory, 'ghost.db'));

    try {
      database.append(event('event-1'));
      database.append(event('event-2', 'assistant_message'));

      expect(database.latestSessionId()).toBe('session-1');
      expect(database.eventsForSession('session-1').map(({ id, sequence }) => ({ id, sequence }))).toEqual([
        { id: 'event-1', sequence: 1 },
        { id: 'event-2', sequence: 2 },
      ]);
      expect(database.eventsForSession('session-1').at(0)?.schemaVersion).toBe(1);
      expect(database.eventsForSession('session-1').at(0)?.trustClass).toBe('user');
      expect(() => database.append(event('event-1'))).toThrow('append-only');
    } finally {
      database.close();
    }
  });

  it('redacts secrets before they are persisted', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ghostd-test-'));
    temporaryDirectories.push(directory);
    const database = await GhostDatabase.open(join(directory, 'ghost.db'));

    try {
      database.append({
        ...event('event-secret'),
        payload: { apiKey: 'sk-example-secret-value', text: 'Authorization: Bearer private-token-value' },
      });

      expect(database.eventsForSession('session-1').at(0)?.payload).toEqual({
        apiKey: '[REDACTED]',
        text: 'Authorization: [REDACTED]',
      });
    } finally {
      database.close();
    }
  });

  it('keeps provider and workspace sessions distinct and requires explicit selection when concurrent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ghostd-session-test-'));
    temporaryDirectories.push(directory);
    const database = await GhostDatabase.open(join(directory, 'ghost.db'));
    try {
      const captured = (id: string, source: 'codex' | 'claude', workspace: string, type: GhostEvent['type'] = 'session_start'): GhostEvent => ({
        ...event(id, type),
        source,
        sessionId: 'shared-provider-session',
        timestamp: `2026-08-19T12:00:0${id.at(-1) ?? '0'}.000Z`,
        workspace: { cwd: workspace },
      });
      database.append(captured('codex-a', 'codex', '/work/a'));
      database.append(captured('codex-b', 'codex', '/work/b'));
      database.append(captured('claude-a', 'claude', '/work/a'));

      const workspaceSessions = database.sessions('/work/a');
      expect(workspaceSessions).toHaveLength(2);
      expect(new Set(workspaceSessions.map(({ id }) => id)).size).toBe(2);
      expect(database.resolvedSession('/work/a')).toBeUndefined();
      expect(() => database.eventsForSession('shared-provider-session')).toThrow('ambiguous');

      const chosen = workspaceSessions.find(({ source }) => source === 'claude');
      expect(chosen).toBeDefined();
      database.setActiveSession('/work/a', chosen?.id as string);
      expect(database.resolvedSession('/work/a')).toMatchObject({ id: chosen?.id, source: 'claude', sourceSessionId: 'shared-provider-session' });
      expect(database.resolvedSession('/work/b')).toMatchObject({ source: 'codex', workspaceCwd: '/work/b' });

      database.append(captured('claude-end', 'claude', '/work/a', 'session_end'));
      expect(database.session(chosen?.id as string)?.endedAt).toBe('2026-08-19T12:00:0d.000Z');
    } finally {
      database.close();
    }
  });
});
