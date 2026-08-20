import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ClaudeTargetAdapter } from '../src/adapters/claude/target.js';
import { GeminiTargetAdapter } from '../src/adapters/gemini/target.js';
import type { GhostEvent, WorkspaceState } from '../src/core/events.js';
import { GhostDatabase } from '../src/db/database.js';
import { ComparisonService } from '../src/reasoning/service.js';

const temporaryDirectories: string[] = [];
const workspace: WorkspaceState = { cwd: '/work/ghost', gitHead: 'abc123', gitStatus: '' };

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

function event(id: string, timestamp: string, text: string): GhostEvent {
  return {
    schemaVersion: 1,
    id,
    sessionId: 'session-1',
    timestamp,
    source: 'codex',
    type: 'user_message',
    trustClass: 'user',
    payload: { text },
    workspace,
  };
}

async function openDatabase(): Promise<GhostDatabase> {
  const directory = await mkdtemp(join(tmpdir(), 'ghostd-reasoning-'));
  temporaryDirectories.push(directory);
  return GhostDatabase.open(join(directory, 'ghost.db'));
}

function insights(finding: string, eventId = 'event-1'): string {
  return JSON.stringify({
    findings: [finding],
    evidence: [{ text: 'The objective is directly captured.', eventIds: [eventId] }],
    recommendations: ['Keep the work scoped.'],
  });
}

describe('Phase 4 multi-agent reasoning', () => {
  it('compares Claude and Gemini against one frozen revision and stores only evidence-backed insights', async () => {
    const database = await openDatabase();
    try {
      database.append(event('event-1', '2026-08-19T12:00:00.000Z', 'Implement the ledger.'));
      const first = database.createRevision('session-1');
      database.createBranch('analysis', first.id);
      database.append(event('event-2', '2026-08-19T12:01:00.000Z', 'This future event must not leak.'));
      const requests: string[] = [];
      const claude = new ClaudeTargetAdapter({
        apiKey: 'test-key',
        model: 'claude-test',
        fetchImpl: async (_input, init) => {
          requests.push(String(init?.body));
          return new Response(JSON.stringify({
            id: 'claude-compare',
            model: 'claude-test',
            content: [{ type: 'text', text: insights('Claude agrees.') }],
            usage: { input_tokens: 10, output_tokens: 8 },
          }));
        },
      });
      const gemini = new GeminiTargetAdapter({
        apiKey: 'test-key',
        model: 'gemini-test',
        fetchImpl: async (_input, init) => {
          requests.push(String(init?.body));
          return new Response(JSON.stringify({
            responseId: 'gemini-compare',
            modelVersion: 'gemini-test',
            candidates: [{ content: { parts: [{ text: insights('Gemini agrees.') }] } }],
            usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 7 },
          }));
        },
      });

      const result = await new ComparisonService(
        database,
        [claude, gemini],
        () => '2026-08-19T12:02:00.000Z',
        (() => { let value = 0; return () => value++ * 5; })(),
      ).compare({ branchName: 'analysis', prompt: 'Review the current plan.' });

      expect(result.run).toMatchObject({
        frozenRevisionId: first.id,
        workspaceSnapshotId: first.workspaceSnapshotId,
        status: 'succeeded',
      });
      expect(result.participants).toEqual([
        expect.objectContaining({ provider: 'claude', status: 'succeeded', responseText: insights('Claude agrees.') }),
        expect.objectContaining({ provider: 'gemini', status: 'succeeded', responseText: insights('Gemini agrees.') }),
      ]);
      expect(result.insights).toHaveLength(6);
      expect(result.insights.filter(({ kind }) => kind === 'evidence')).toEqual([
        expect.objectContaining({ eventIds: ['event-1'] }),
        expect.objectContaining({ eventIds: ['event-1'] }),
      ]);
      expect(requests).toHaveLength(2);
      expect(requests.join('\n')).toContain('Implement the ledger.');
      expect(requests.join('\n')).not.toContain('This future event must not leak.');
    } finally {
      database.close();
    }
  });

  it('records a partial compare when Gemini fails and rejects unsupported evidence IDs', async () => {
    const database = await openDatabase();
    try {
      database.append(event('event-1', '2026-08-19T12:00:00.000Z', 'Inspect the authorization boundary.'));
      const revision = database.createRevision('session-1');
      database.createBranch('security', revision.id);
      const claude = new ClaudeTargetAdapter({
        apiKey: 'test-key',
        fetchImpl: async () => new Response(JSON.stringify({
          id: 'claude-partial',
          content: [{ type: 'text', text: insights('Unsupported evidence.', 'not-in-revision') }],
        })),
      });
      const gemini = new GeminiTargetAdapter({
        apiKey: 'test-key',
        fetchImpl: async () => new Response('private Gemini error body', { status: 429 }),
      });

      const result = await new ComparisonService(database, [claude, gemini]).compare({
        branchName: 'security',
        prompt: 'Review risks.',
      });

      expect(result.run.status).toBe('partial');
      expect(result.participants).toEqual([
        expect.objectContaining({ provider: 'claude', status: 'succeeded' }),
        expect.objectContaining({ provider: 'gemini', status: 'failed', failureCode: 'http_429' }),
      ]);
      expect(result.insights).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('requires explicit copy, merge, and switch actions without duplicating canonical events', async () => {
    const database = await openDatabase();
    try {
      database.append(event('event-1', '2026-08-19T12:00:00.000Z', 'Initial state.'));
      const first = database.createRevision('session-1');
      database.createBranch('main', first.id);
      database.createBranch('review', first.id);
      database.append(event('event-2', '2026-08-19T12:01:00.000Z', 'Reviewed state.'));
      const rebased = database.rebaseBranch('review');

      const copy = database.copyBranch('review', 'review-copy', '2026-08-19T12:02:00.000Z');
      expect(copy.revisionId).toBe(rebased.latestRevision.id);
      expect(database.branch('review-copy')).toMatchObject({ headRevisionId: rebased.latestRevision.id });
      expect(database.copiesFromBranch('review')).toEqual([copy]);
      expect(database.eventsForSession('session-1')).toHaveLength(2);
      expect(database.branch('main')?.headRevisionId).toBe(first.id);

      const merge = database.mergeBranches('review', 'main', '2026-08-19T12:03:00.000Z');
      expect(merge).toMatchObject({ merged: true, headRevisionId: rebased.latestRevision.id });
      expect(database.branch('main')?.headRevisionId).toBe(rebased.latestRevision.id);
      expect(database.mergesIntoBranch('main')).toEqual([merge.merge]);

      const handoff = database.switchAgent('main', 'gemini', '2026-08-19T12:04:00.000Z');
      expect(handoff).toMatchObject({ targetAgent: 'gemini', revisionId: rebased.latestRevision.id });
      expect(database.agentSwitches('main')).toEqual([handoff]);
      expect(() => database.mergeBranches('review-copy', 'main')).not.toThrow();
    } finally {
      database.close();
    }
  });
});
