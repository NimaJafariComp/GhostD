import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ClaudeTargetAdapter } from '../src/adapters/claude/target.js';
import { compileContext, renderContext } from '../src/context/compiler.js';
import type { GhostEvent } from '../src/core/events.js';
import { GhostDatabase } from '../src/db/database.js';
import { MaterializationService } from '../src/materialization/service.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

function event(
  id: string,
  timestamp: string,
  text: string,
  temporal: Record<string, unknown>,
): GhostEvent {
  return {
    schemaVersion: 1,
    id,
    sessionId: 'session-1',
    timestamp,
    source: 'codex',
    type: 'user_message',
    trustClass: 'user',
    payload: { text, temporal },
    workspace: { cwd: '/work/ghost', gitHead: 'abc123', gitStatus: '' },
  };
}

async function openDatabase(): Promise<GhostDatabase> {
  const directory = await mkdtemp(join(tmpdir(), 'ghostd-sync-'));
  temporaryDirectories.push(directory);
  return GhostDatabase.open(join(directory, 'ghost.db'));
}

describe('Phase 3 synchronization and temporal context', () => {
  it('detects a lazy delta, preserves stale provider output, and explicitly rebases without rewriting history', async () => {
    const database = await openDatabase();
    try {
      database.append(event(
        'blue-constraint',
        '2026-08-19T12:00:00.000Z',
        'Use blue only.',
        { relation: 'asserted', factId: 'color-blue', kind: 'constraint', value: 'Use blue only.' },
      ));
      const first = database.createRevision('session-1');
      const branch = database.createBranch('review', first.id);
      const materialization = database.recordMaterialization('review', 'claude', first.id, 'provider-1');
      database.append(event(
        'green-constraint',
        '2026-08-19T12:01:00.000Z',
        'Use green only.',
        {
          relation: 'supersedes',
          factId: 'color-green',
          targetFactId: 'color-blue',
          kind: 'constraint',
          value: 'Use green only.',
        },
      ));

      const pending = database.branchSynchronizationStatus('review');
      expect(pending).toMatchObject({
        branch: { id: branch.id, headRevisionId: first.id, trackingRevisionId: first.id },
        latestRevision: { eventHighWaterMark: 2 },
        pendingEventCount: 1,
        rebaseRequired: true,
        staleMaterializationCount: 0,
      });
      expect(database.materializationStatus(materialization.id)?.stale).toBe(false);

      const rebased = database.rebaseBranch('review', '2026-08-19T12:02:00.000Z');
      expect(rebased).toMatchObject({
        rebased: true,
        addedEventCount: 1,
        branch: { baseRevisionId: first.id, headRevisionId: rebased.latestRevision.id, trackingRevisionId: rebased.latestRevision.id },
        rebase: { fromRevisionId: first.id, toRevisionId: rebased.latestRevision.id, createdAt: '2026-08-19T12:02:00.000Z' },
      });
      expect(database.rebasesForBranch('review')).toEqual([rebased.rebase]);
      expect(database.branchSynchronizationStatus('review')).toMatchObject({ pendingEventCount: 0, rebaseRequired: false, staleMaterializationCount: 1 });
      expect(database.materializationStatus(materialization.id)?.stale).toBe(true);
      expect(database.eventsForSession('session-1')).toHaveLength(2);

      const context = compileContext(database.eventsForSessionThrough('session-1', rebased.latestRevision.eventHighWaterMark));
      expect(context.userRequirements.map(({ value }) => value)).toEqual(['Use green only.']);
      expect(context.temporalFacts).toEqual([
        expect.objectContaining({ id: 'color-green', state: 'active', value: 'Use green only.' }),
      ]);
      expect(renderContext(context)).not.toContain('Use blue only.');
    } finally {
      database.close();
    }
  });

  it('materializes the rebased revision rather than an obsolete branch snapshot', async () => {
    const database = await openDatabase();
    try {
      database.append(event(
        'old-hypothesis',
        '2026-08-19T12:00:00.000Z',
        'The cache is the cause.',
        { relation: 'asserted', factId: 'cache-hypothesis', kind: 'hypothesis', value: 'The cache is the cause.' },
      ));
      const first = database.createRevision('session-1');
      database.createBranch('diagnosis', first.id);
      database.append(event(
        'invalidated-hypothesis',
        '2026-08-19T12:01:00.000Z',
        'The cache hypothesis was disproven.',
        { relation: 'invalidates', targetFactId: 'cache-hypothesis' },
      ));
      const rebased = database.rebaseBranch('diagnosis');
      const requests: string[] = [];
      const target = new ClaudeTargetAdapter({
        apiKey: 'test-key',
        model: 'claude-test',
        fetchImpl: async (_input, init) => {
          requests.push(String(init?.body));
          return new Response(JSON.stringify({
            id: 'msg-rebased',
            content: [{ type: 'text', text: 'The hypothesis is invalidated.' }],
            usage: { input_tokens: 5, output_tokens: 4 },
          }));
        },
      });

      const result = await new MaterializationService(database, target).askClaude({
        branchName: 'diagnosis',
        prompt: 'What is currently true?',
        mode: 'persistent',
      });

      expect(result.revision.id).toBe(rebased.latestRevision.id);
      expect(requests[0]).not.toContain('The cache is the cause.');
      expect(database.materializationStatus(result.run.materializationId ?? '')?.stale).toBe(false);
    } finally {
      database.close();
    }
  });
});
