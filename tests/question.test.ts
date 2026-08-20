import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ContextTargetAdapter, TargetRequest, TargetResult } from '../src/adapters/targets.js';
import type { GhostEvent } from '../src/core/events.js';
import { GhostDatabase } from '../src/db/database.js';
import { MaterializationFailureError, MaterializationService } from '../src/materialization/service.js';
import { QuestionService, resolveQuestionProvider, resolveQuestionSelection, resolveQuestionSession } from '../src/question/service.js';

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

  it('uses the selected captured session provider for an unqualified question and rejects unsupported sources', async () => {
    const database = await openDatabase();
    try {
      database.append({ ...event('one', 'codex-session', 'Current objective.'), source: 'codex' });
      expect(resolveQuestionProvider(database, '/work/ghost')).toMatchObject({ provider: 'codex' });

      database.append({ ...event('two', 'claude-session', 'Current objective.'), source: 'claude' });
      const claude = database.sessions('/work/ghost').find(({ sourceSessionId }) => sourceSessionId === 'claude-session');
      expect(claude).toBeDefined();
      database.setActiveSession('/work/ghost', claude?.id ?? 'missing');
      expect(resolveQuestionProvider(database, '/work/ghost')).toMatchObject({ sessionId: claude?.id, provider: 'claude' });

      const unsupported = await openDatabase();
      unsupported.append({ ...event('three', 'antigravity-session', 'Current objective.'), source: 'antigravity' });
      expect(() => resolveQuestionProvider(unsupported, '/work/ghost')).toThrow('has no configured GhostD answer target');
      unsupported.close();
    } finally {
      database.close();
    }
  });

  it('uses a documented same-provider source model, while cross-provider sidecars default to medium thinking', async () => {
    const database = await openDatabase();
    try {
      database.append({
        ...event('start', 'claude-session', 'Session started.'),
        source: 'claude',
        type: 'session_start',
        payload: { model: 'claude-sonnet-4-6' },
      });
      database.append({ ...event('prompt', 'claude-session', 'Current objective.'), source: 'claude' });
      const session = database.sessions('/work/ghost')[0];
      expect(session).toBeDefined();
      const sessionId = session?.id ?? 'missing';

      expect(resolveQuestionSelection(database, sessionId, 'claude')).toEqual({ model: 'claude-sonnet-4-6' });
      expect(resolveQuestionSelection(database, sessionId, 'gemini')).toEqual({ thinking: 'medium' });

      database.setSessionAnswerPreference(sessionId, 'gemini', { model: 'gemini-3.6-flash' }, '2026-08-20T12:01:00.000Z');
      expect(resolveQuestionSelection(database, sessionId, 'gemini')).toEqual({ model: 'gemini-3.6-flash', thinking: 'medium' });
      database.setSessionAnswerPreference(sessionId, 'gemini', { thinking: 'high' }, '2026-08-20T12:02:00.000Z');
      expect(resolveQuestionSelection(database, sessionId, 'gemini')).toEqual({ model: 'gemini-3.6-flash', thinking: 'high' });
      expect(database.sessionAnswerPreferences(sessionId)).toMatchObject([
        { provider: 'gemini', model: 'gemini-3.6-flash', thinking: 'high' },
      ]);
    } finally {
      database.close();
    }
  });

  it('forwards a selected model and thinking policy and records both with the sidecar run', async () => {
    const database = await openDatabase();
    try {
      database.append(event('one', 'session-one', 'Current objective.'));
      const requests: TargetRequest[] = [];
      const claude = target('claude', async (request) => {
        requests.push(request);
        return { model: request.model ?? 'claude-test', text: 'Read-only answer.' };
      });
      const gemini = target('gemini', async () => ({ model: 'gemini-test', text: 'unused' }));
      const materialization = new MaterializationService(database, claude, () => '2026-08-20T12:01:00.000Z', () => 10, gemini);

      const result = await new QuestionService(database, materialization, () => 'model-choice').ask({
        sessionId: 'session-one',
        provider: 'claude',
        model: 'claude-sonnet-4-6',
        thinking: 'medium',
        prompt: 'What is true now?',
      });

      expect(requests[0]).toMatchObject({ model: 'claude-sonnet-4-6', thinking: 'medium' });
      expect(result.run).toMatchObject({ model: 'claude-sonnet-4-6', thinking: 'medium' });
    } finally {
      database.close();
    }
  });

  it('takes a fresh captured-session checkpoint for every question, persists a redacted run, and leaves only closed internal ephemeral anchors', async () => {
    const database = await openDatabase();
    try {
      database.append(event('one', 'session-one', 'The current objective is safe.'));
      const requests: TargetRequest[] = [];
      const claude = target('claude', async (request) => {
        requests.push(request);
        if (requests.length === 1) {
          database.append(event('later', 'session-one', 'Later state must not enter the first question.'));
        }
        return { model: 'claude-test', text: 'API key: answer-secret', inputTokens: 2, outputTokens: 3 };
      });
      const gemini = target('gemini', async () => ({ model: 'gemini-test', text: 'unused' }));
      const materialization = new MaterializationService(database, claude, () => '2026-08-19T12:01:00.000Z', () => 10, gemini);
      const questions = new QuestionService(database, materialization, () => requests.length === 0 ? 'first' : 'second');
      const result = await questions.ask({
        sessionId: 'session-one',
        provider: 'claude',
        prompt: 'What is true now?',
      });
      const nextResult = await questions.ask({
        sessionId: 'session-one',
        provider: 'claude',
        prompt: 'What changed?',
      });

      expect(result.revision.eventHighWaterMark).toBe(1);
      expect(nextResult.revision.eventHighWaterMark).toBe(2);
      expect(result.snapshot).toMatchObject({ cwd: '/work/ghost', gitHead: 'abc123', gitStatus: '' });
      expect(requests[0]?.prompt).toContain('The current objective is safe.');
      expect(requests[0]?.prompt).not.toContain('Later state must not enter the first question.');
      expect(requests[1]?.prompt).toContain('Later state must not enter the first question.');
      expect(result.run).toMatchObject({ mode: 'ephemeral', provider: 'claude', sourceRevisionId: result.revision.id, responseText: 'API key: [REDACTED]' });
      expect(database.branch('question-first')).toMatchObject({ persistence: 'ephemeral', lifecycle: 'closed', headRevisionId: result.revision.id });
      expect(database.branch('question-second')).toMatchObject({ persistence: 'ephemeral', lifecycle: 'closed', headRevisionId: nextResult.revision.id });
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

  it('runs Codex through the same ephemeral revision-pinned sidecar path', async () => {
    const database = await openDatabase();
    try {
      database.append(event('one', 'session-one', 'Current objective.'));
      const claude = target('claude', async () => ({ model: 'claude-test', text: 'unused' }));
      const gemini = target('gemini', async () => ({ model: 'gemini-test', text: 'unused' }));
      const codex = target('codex', async () => ({ model: 'codex-test', text: 'Codex sidecar answer.' }));
      const materialization = new MaterializationService(database, claude, () => '2026-08-19T12:01:00.000Z', () => 10, gemini, codex);

      const result = await new QuestionService(database, materialization, () => 'codex').ask({
        sessionId: 'session-one',
        provider: 'codex',
        prompt: 'What is true now?',
      });

      expect(result).toMatchObject({ text: 'Codex sidecar answer.', run: { provider: 'codex', mode: 'ephemeral', status: 'succeeded' } });
      expect(database.branch('question-codex')).toMatchObject({ persistence: 'ephemeral', lifecycle: 'closed' });
    } finally {
      database.close();
    }
  });
});
