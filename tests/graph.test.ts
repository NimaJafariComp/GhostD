import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { GhostEvent } from '../src/core/events.js';
import { GhostDatabase } from '../src/db/database.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

function event(
  id: string,
  sessionId = 'session-1',
  timestamp = '2026-08-19T12:00:00.000Z',
  gitStatus = '',
): GhostEvent {
  return {
    schemaVersion: 1,
    id,
    sessionId,
    timestamp,
    source: 'codex',
    type: 'user_message',
    trustClass: 'user',
    payload: { text: `Objective ${id}` },
    workspace: { cwd: '/work/ghost', gitHead: 'abc123', gitStatus },
  };
}

async function openDatabase(): Promise<GhostDatabase> {
  const directory = await mkdtemp(join(tmpdir(), 'ghostd-graph-'));
  temporaryDirectories.push(directory);
  return GhostDatabase.open(join(directory, 'ghost.db'));
}

describe('Phase 1 context graph', () => {
  it('creates immutable checkpoints with ordered ancestry and workspace identities', async () => {
    const database = await openDatabase();
    try {
      database.append(event('event-1'));
      const first = database.createRevision('session-1');
      const repeated = database.createRevision('session-1');
      database.append(event('event-2', 'session-1', '2026-08-19T12:01:00.000Z', ' M src/core/events.ts'));
      const second = database.createRevision('session-1');

      expect(repeated).toEqual(first);
      expect(first.eventHighWaterMark).toBe(1);
      expect('parentRevisionId' in first).toBe(false);
      expect(second).toMatchObject({ eventHighWaterMark: 2, parentRevisionId: first.id });
      expect(second.workspaceSnapshotId).not.toBe(first.workspaceSnapshotId);
      expect(database.workspaceSnapshot(second.workspaceSnapshotId)).toEqual({
        id: second.workspaceSnapshotId,
        cwd: '/work/ghost',
        gitHead: 'abc123',
        gitStatus: ' M src/core/events.ts',
      });
      expect(database.isRevisionAncestor(first.id, second.id)).toBe(true);
      expect(database.isRevisionAncestor(second.id, first.id)).toBe(false);
    } finally {
      database.close();
    }
  });

  it('creates cold copy-on-write branches without duplicating canonical events', async () => {
    const database = await openDatabase();
    try {
      database.append(event('event-1'));
      const revision = database.createRevision('session-1');
      const persistent = database.createBranch('review', revision.id);
      const ephemeral = database.createBranch('scratch', revision.id, 'ephemeral');

      expect(persistent).toMatchObject({
        persistence: 'persistent',
        lifecycle: 'open',
        baseRevisionId: revision.id,
        headRevisionId: revision.id,
        trackingRevisionId: revision.id,
        originatingSessionId: 'session-1',
      });
      expect(ephemeral.persistence).toBe('ephemeral');
      expect(database.eventsForSession('session-1')).toHaveLength(1);
      expect(() => database.createBranch('review', revision.id)).toThrow('already exists');
    } finally {
      database.close();
    }
  });

  it('attributes provider state to exact reachable revisions and preserves closed branch history', async () => {
    const database = await openDatabase();
    try {
      database.append(event('event-1'));
      const first = database.createRevision('session-1');
      database.append(event('event-2', 'session-1', '2026-08-19T12:01:00.000Z'));
      const second = database.createRevision('session-1');
      const branch = database.createBranch('analysis', second.id);
      const stale = database.recordMaterialization('analysis', 'codex', first.id, 'provider-handle-1');
      const current = database.recordMaterialization('analysis', 'claude', second.id);

      expect(database.materializationStatus(stale.id)).toEqual({ materialization: stale, stale: true });
      expect(database.materializationStatus(current.id)).toEqual({ materialization: current, stale: false });

      database.append(event('other-session-event', 'session-2'));
      const unrelated = database.createRevision('session-2');
      expect(() => database.recordMaterialization('analysis', 'gemini', unrelated.id)).toThrow('not reachable');

      const closed = database.closeBranch(branch.name, '2026-08-19T12:02:00.000Z');
      expect(closed).toMatchObject({ lifecycle: 'closed', closedAt: '2026-08-19T12:02:00.000Z' });
      expect(database.branch('analysis')).toEqual(closed);
      expect(database.materializationStatus(stale.id)).toEqual({ materialization: stale, stale: true });
      expect(() => database.recordMaterialization('analysis', 'codex', second.id)).toThrow('is closed');
      expect(database.closeBranch(branch.name, '2026-08-19T12:03:00.000Z')).toEqual(closed);
    } finally {
      database.close();
    }
  });
});
