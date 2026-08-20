import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ContextTargetAdapter, TargetRequest, TargetResult } from '../src/adapters/targets.js';
import type { GhostEvent } from '../src/core/events.js';
import { GhostDatabase } from '../src/db/database.js';
import { MaterializationFailureError, MaterializationService } from '../src/materialization/service.js';
import { QuestionService, resolveQuestionSession } from '../src/question/service.js';

const temporaryDirectories: string[] = [];

afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true }))));

function event(id: string, sessionId: string, text: string): GhostEvent {
  return {
    schemaVersion: 1,
    id,
    sessionId,
    timestamp: '2026-08-19T12:00:00.000Z',
    source: 'fixture',
    type: 'user_message',
    trustClass: 'user',
    payload: { text },
    workspace: { cwd: '/work/ghost', gitHead: 'abc123', gitStatus: '' },
  };
}

async function openDatabase(): Promise<GhostDatabase> {
  const directory = await mkdtemp(join(tmpdir(), 'ghostd-question-'));
  temporaryDirectories.push(directory);
  return GhostDatabase.open(join(directory, 'ghost.db'));
}

function target(provider: 'claude' | 'gemini', ask: (request: TargetRequest) => Promise<TargetResult>): ContextTargetAdapter {
  return {
    model: `${provider}-test`,
    capabilities: {
      provider,
      supportsNativeFork: false,
      supportsSessionResume: false,
      cacheScope: 'request',
      cacheLifetime: 'ephemeral',
      contextWindowTokens: 1_000,
      workspaceAccess: 'none',
      toolAccess: 'none',
      writeAccess: false,
    },
    ask,
  };
}

describe('terminal-first sidecar questions', () => {
  it('resolves one captured session, but refuses none or ambiguity without guessing', async () => {
    const database = await openDatabase();
    try {
      expect(() => resolveQuestionSession(database, '/work/ghost')).toThrow('No active Ghost session');
      database.append(event('one', 'session-one', 'First.'));
      expect(resolveQuestionSession(database, '/work/ghost')).toBe(database.sessions('/work/ghost')[0]?.id);
      database.append(event('two', 'session-two', 'Second.'));
      expect(() => resolveQuestionSession(database, '/work/ghost')).toThrow('Multiple open Ghost sessions');
      const selected = database.sessions('/work/ghost').find(({ sourceSessionId }) => sourceSessionId === 'session-two');
      expect(selected).toBeDefined();
      database.setActiveSession('/work/ghost', selected?.id ?? 'missing');
      expect(resolveQuestionSession(database, '/work/ghost')).toBe(selected?.id);
    } finally {
      database.close();
    }
  });

  it('pins the current revision, persists a redacted run, and leaves only a closed internal ephemeral anchor', async () => {
    const database = await openDatabase();
    try {
      database.append(event('one', 'session-one', 'The current objective is safe.'));
      const requests: TargetRequest[] = [];
      const claude = target('claude', async (request) => {
        requests.push(request);
        database.append(event('later', 'session-one', 'Later state must not enter this question.'));
        return { model: 'claude-test', text: 'API key: answer-secret', inputTokens: 2, outputTokens: 3 };
      });
      const gemini = target('gemini', async () => ({ model: 'gemini-test', text: 'unused' }));
      const materialization = new MaterializationService(database, claude, () => '2026-08-19T12:01:00.000Z', () => 10, gemini);
      const result = await new QuestionService(database, materialization, () => 'fixed').ask({
        sessionId: 'session-one',
        provider: 'claude',
        prompt: 'What is true now?',
      });

      expect(result.revision.eventHighWaterMark).toBe(1);
      expect(result.snapshot).toMatchObject({ cwd: '/work/ghost', gitHead: 'abc123', gitStatus: '' });
      expect(requests[0]?.prompt).toContain('The current objective is safe.');
      expect(requests[0]?.prompt).not.toContain('Later state must not enter this question.');
      expect(result.run).toMatchObject({ mode: 'ephemeral', provider: 'claude', sourceRevisionId: result.revision.id, responseText: 'API key: [REDACTED]' });
      expect(database.branch('question-fixed')).toMatchObject({ persistence: 'ephemeral', lifecycle: 'closed', headRevisionId: result.revision.id });
      expect(database.eventsForSession('session-one')).toHaveLength(2);
    } finally {
      database.close();
    }
  });

  it('records provider-unavailable recovery and closes the internal anchor', async () => {
    const database = await openDatabase();
    try {
      database.append(event('one', 'session-one', 'Current objective.'));
      const unavailable = target('claude', async () => { throw new Error('provider unavailable'); });
      const gemini = target('gemini', async () => ({ model: 'gemini-test', text: 'unused' }));
      const materialization = new MaterializationService(database, unavailable, () => '2026-08-19T12:01:00.000Z', () => 10, gemini);

      await expect(new QuestionService(database, materialization, () => 'failed').ask({
        sessionId: 'session-one',
        provider: 'claude',
        prompt: 'What is true now?',
      })).rejects.toBeInstanceOf(MaterializationFailureError);

      expect(database.branch('question-failed')).toMatchObject({ persistence: 'ephemeral', lifecycle: 'closed' });
      expect(database.latestMaterializationRun('question-failed')).toMatchObject({ status: 'failed', recovery: expect.stringContaining('Ghost retained the source revision') });
    } finally {
      database.close();
    }
  });
});
