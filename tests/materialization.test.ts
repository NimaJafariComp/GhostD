import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ClaudeApiError, ClaudeTargetAdapter } from '../src/adapters/claude/target.js';
import { chooseMaterializationStrategy } from '../src/adapters/targets.js';
import type { GhostEvent } from '../src/core/events.js';
import { GhostDatabase } from '../src/db/database.js';
import { MaterializationFailureError, MaterializationService } from '../src/materialization/service.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

function event(id: string, timestamp: string, text: string): GhostEvent {
  return {
    schemaVersion: 1,
    id,
    sessionId: 'session-1',
    timestamp,
    source: 'fixture',
    type: 'user_message',
    trustClass: 'user',
    payload: { text },
    workspace: { cwd: '/work/ghost', gitHead: 'abc123', gitStatus: '' },
  };
}

async function openDatabase(): Promise<GhostDatabase> {
  const directory = await mkdtemp(join(tmpdir(), 'ghostd-materialization-'));
  temporaryDirectories.push(directory);
  return GhostDatabase.open(join(directory, 'ghost.db'));
}

function successfulFetch(capturedBodies: string[]): typeof fetch {
  return async (_input, init) => {
    capturedBodies.push(String(init?.body));
    return new Response(JSON.stringify({
      id: 'msg_123',
      model: 'claude-test',
      content: [{ type: 'text', text: 'Read-only answer.' }],
      usage: { input_tokens: 19, output_tokens: 7 },
    }), { status: 200 });
  };
}

describe('Claude materialization', () => {
  it('uses the documented Messages boundary with no tools or write capabilities', async () => {
    const bodies: string[] = [];
    const target = new ClaudeTargetAdapter({ apiKey: 'test-key', model: 'claude-test', fetchImpl: successfulFetch(bodies) });

    const result = await target.ask({ system: 'Read only.', prompt: 'Explain the context.' });
    const body = JSON.parse(bodies[0] ?? '') as Record<string, unknown>;

    expect(target.capabilities).toMatchObject({
      provider: 'claude',
      supportsNativeFork: false,
      supportsSessionResume: false,
      cacheScope: 'request',
      cacheLifetime: 'ephemeral',
      contextWindowTokens: 1_000_000,
      workspaceAccess: 'none',
      toolAccess: 'none',
      writeAccess: false,
    });
    expect(chooseMaterializationStrategy(target.capabilities)).toBe('context_replay');
    expect(body).toMatchObject({
      model: 'claude-test',
      system: 'Read only.',
      messages: [{ role: 'user', content: 'Explain the context.' }],
    });
    expect(body).not.toHaveProperty('tools');
    expect(result).toEqual({
      providerHandle: 'msg_123',
      model: 'claude-test',
      text: 'Read-only answer.',
      inputTokens: 19,
      outputTokens: 7,
    });
  });

  it('pins context to the branch revision, redacts remote text, and records provider usage', async () => {
    const database = await openDatabase();
    try {
      database.append(event('event-1', '2026-08-19T12:00:00.000Z', 'Original objective. API key: original-secret'));
      const revision = database.createRevision('session-1');
      database.createBranch('review', revision.id);
      database.append(event('event-2', '2026-08-19T12:01:00.000Z', 'Future objective that must not be materialized.'));
      const bodies: string[] = [];
      const target = new ClaudeTargetAdapter({ apiKey: 'test-key', model: 'claude-test', fetchImpl: successfulFetch(bodies) });
      vi.stubEnv('GHOST_CLAUDE_INPUT_USD_PER_MILLION_TOKENS', '2');
      vi.stubEnv('GHOST_CLAUDE_OUTPUT_USD_PER_MILLION_TOKENS', '3');
      let clockCalls = 0;
      const service = new MaterializationService(
        database,
        target,
        () => '2026-08-19T12:02:00.000Z',
        () => clockCalls++ === 0 ? 100 : 125,
      );

      const result = await service.askClaude({
        branchName: 'review',
        prompt: 'Check this API key: prompt-secret',
        mode: 'persistent',
      });
      const request = bodies[0] ?? '';

      expect(request).toContain(revision.id);
      expect(request).toContain('[REDACTED]');
      expect(request).not.toContain('original-secret');
      expect(request).not.toContain('prompt-secret');
      expect(request).not.toContain('Future objective');
      expect(result.run).toMatchObject({
        provider: 'claude',
        model: 'claude-test',
        sourceRevisionId: revision.id,
        mode: 'persistent',
        strategy: 'context_replay',
        status: 'succeeded',
        providerHandle: 'msg_123',
        inputTokens: 19,
        outputTokens: 7,
        estimatedCostUsd: 0.000059,
        latencyMs: 25,
        responseText: 'Read-only answer.',
      });
      expect(database.materializationStatus(result.run.materializationId ?? '')?.stale).toBe(false);
    } finally {
      database.close();
    }
  });

  it('records retry-safe recovery details when Claude rejects a request', async () => {
    const database = await openDatabase();
    try {
      database.append(event('event-1', '2026-08-19T12:00:00.000Z', 'Original objective.'));
      const revision = database.createRevision('session-1');
      database.createBranch('retry', revision.id);
      const rejectedFetch: typeof fetch = async () => new Response('unavailable', { status: 429 });
      const service = new MaterializationService(
        database,
        new ClaudeTargetAdapter({ apiKey: 'test-key', fetchImpl: rejectedFetch }),
        () => '2026-08-19T12:01:00.000Z',
      );

      await expect(service.askClaude({ branchName: 'retry', prompt: 'Try later.', mode: 'persistent' }))
        .rejects.toBeInstanceOf(MaterializationFailureError);

      expect(database.latestMaterializationRun('retry')).toMatchObject({
        sourceRevisionId: revision.id,
        status: 'failed',
        failureCode: 'http_429',
        recovery: expect.stringContaining('Ghost retained the source revision'),
      });
    } finally {
      database.close();
    }
  });

  it('stores a redacted answer copy while returning the provider answer to the caller', async () => {
    const database = await openDatabase();
    try {
      database.append(event('event-1', '2026-08-19T12:00:00.000Z', 'Original objective.'));
      const revision = database.createRevision('session-1');
      database.createBranch('answer-storage', revision.id);
      const secretResponseFetch: typeof fetch = async () => new Response(JSON.stringify({
        id: 'msg_secret',
        content: [{ type: 'text', text: 'API key: provider-secret' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200 });
      const service = new MaterializationService(
        database,
        new ClaudeTargetAdapter({ apiKey: 'test-key', fetchImpl: secretResponseFetch }),
      );

      const result = await service.askClaude({ branchName: 'answer-storage', prompt: 'Answer.', mode: 'persistent' });

      expect(result.text).toBe('API key: provider-secret');
      expect(result.run.responseText).toBe('API key: [REDACTED]');
    } finally {
      database.close();
    }
  });

  it('does not expose provider response bodies through API errors', async () => {
    const rejectedFetch: typeof fetch = async () => new Response('contains sensitive provider detail', { status: 500 });
    const target = new ClaudeTargetAdapter({ apiKey: 'test-key', fetchImpl: rejectedFetch });

    await expect(target.ask({ system: 'Read only.', prompt: 'Hello.' })).rejects.toEqual(new ClaudeApiError(500));
  });
});
