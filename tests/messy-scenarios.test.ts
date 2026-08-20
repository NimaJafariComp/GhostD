import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CodexAdapter } from '../src/adapters/codex/adapter.js';
import { ClaudeSourceAdapter } from '../src/adapters/claude/source.js';
import { GeminiSourceAdapter } from '../src/adapters/gemini/source.js';
import { compileContext, renderContext } from '../src/context/compiler.js';
import type { WorkspaceState } from '../src/core/events.js';
import { GhostDatabase } from '../src/db/database.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

async function database(): Promise<GhostDatabase> {
  const directory = await mkdtemp(join(tmpdir(), 'ghostd-messy-scenarios-'));
  temporaryDirectories.push(directory);
  return GhostDatabase.open(join(directory, 'ghost.db'));
}

function contextFor(database_: GhostDatabase, workspace: string, source: string) {
  const session = database_.sessions(workspace).find((candidate) => candidate.source === source);
  if (session === undefined) throw new Error(`Expected a ${source} session.`);
  return compileContext(database_.eventsForSession(session.id));
}

describe('messy multi-host user scenarios', () => {
  it('processes a Codex implementation with a failed test, a decision, and a dirty tree', async () => {
    const database_ = await database();
    const workspace: WorkspaceState = {
      cwd: '/work/payments',
      gitHead: 'abc123',
      gitStatus: ' M src/retry.ts\n M tests/retry.test.ts',
    };
    const adapter = new CodexAdapter(() => workspace, () => '2026-08-20T03:20:00.000Z', (() => {
      let index = 0;
      return () => `codex-event-${++index}`;
    })());
    try {
      for (const input of [
        { hook_event_name: 'SessionStart', session_id: 'codex-messy', event_id: 'start' },
        { hook_event_name: 'UserPromptSubmit', session_id: 'codex-messy', event_id: 'prompt', prompt: 'Implement retry backoff. Do not change the public API.' },
        { hook_event_name: 'PreToolUse', session_id: 'codex-messy', event_id: 'test-start', tool_name: 'exec_command', tool_input: { cmd: 'npm test' } },
        { hook_event_name: 'PostToolUse', session_id: 'codex-messy', event_id: 'test-result', tool_name: 'exec_command', tool_response: 'retry test failed with exit code 1' },
        { hook_event_name: 'Stop', session_id: 'codex-messy', event_id: 'done', last_assistant_message: 'We decided to use bounded exponential backoff.' },
      ]) {
        for (const event of adapter.normalize(input)) database_.append(event);
      }

      const context = contextFor(database_, workspace.cwd, 'codex');
      expect(context.currentObjective.value).toBe('Implement retry backoff. Do not change the public API.');
      expect(context.importantDecisions.map(({ value }) => value)).toEqual(['We decided to use bounded exponential backoff.']);
      expect(context.recentFailures.map(({ value }) => value)).toEqual(['retry test failed with exit code 1']);
      expect(context.modifiedFiles.map(({ value }) => value)).toEqual(['src/retry.ts', 'tests/retry.test.ts']);
      expect(context.workspace.dirty).toBe(true);
    } finally {
      database_.close();
    }
  });

  it('keeps only the current truth after a Claude user changes direction following a failed hypothesis', async () => {
    const database_ = await database();
    const workspace: WorkspaceState = { cwd: '/work/theme', gitHead: 'def456', gitStatus: '' };
    const adapter = new ClaudeSourceAdapter(() => workspace, () => '2026-08-20T03:21:00.000Z', (() => {
      let index = 0;
      return () => `claude-event-${++index}`;
    })());
    try {
      for (const input of [
        { hook_event_name: 'SessionStart', session_id: 'claude-messy', event_id: 'start' },
        { hook_event_name: 'UserPromptSubmit', session_id: 'claude-messy', event_id: 'old-prompt', prompt: 'Implement blue mode.' },
        { hook_event_name: 'MessageDisplay', session_id: 'claude-messy', event_id: 'old-answer', text: 'We decided to use blue mode.' },
        { hook_event_name: 'PostToolUseFailure', session_id: 'claude-messy', event_id: 'failure', tool_name: 'Bash', tool_response: 'theme test failed with exit code 1' },
        { hook_event_name: 'UserPromptSubmit', session_id: 'claude-messy', event_id: 'new-prompt', prompt: 'The user changed direction. Implement green mode instead. Do not use blue mode.' },
        { hook_event_name: 'MessageDisplay', session_id: 'claude-messy', event_id: 'new-answer', text: 'We decided to use green mode.' },
        { hook_event_name: 'SessionEnd', session_id: 'claude-messy', event_id: 'end' },
      ]) {
        for (const event of adapter.normalize(input)) database_.append(event);
      }

      const context = contextFor(database_, workspace.cwd, 'claude');
      const rendered = renderContext(context);
      expect(context.currentObjective.value).toContain('green mode');
      expect(context.importantDecisions.map(({ value }) => value)).toEqual(['We decided to use green mode.']);
      expect(rendered).not.toContain('We decided to use blue mode.');
      expect(rendered).not.toContain('theme test failed with exit code 1');
    } finally {
      database_.close();
    }
  });

  it('redacts Gemini tool credentials before storage while retaining a large result and final decision', async () => {
    const database_ = await database();
    const workspace: WorkspaceState = { cwd: '/work/secrets', gitHead: 'fedcba', gitStatus: '' };
    const adapter = new GeminiSourceAdapter(() => workspace, () => '2026-08-20T03:22:00.000Z', (() => {
      let index = 0;
      return () => `gemini-event-${++index}`;
    })());
    const largeOutput = 'x'.repeat(12_001);
    try {
      for (const input of [
        { hook_event_name: 'SessionStart', session_id: 'gemini-messy', event_id: 'start' },
        { hook_event_name: 'BeforeAgent', session_id: 'gemini-messy', event_id: 'prompt', prompt: 'Diagnose the deployment output without exposing credentials.' },
        { hook_event_name: 'AfterTool', session_id: 'gemini-messy', event_id: 'tool', tool_name: 'run_shell_command', tool_response: { authorization: 'Bearer top-secret-token', output: largeOutput } },
        { hook_event_name: 'AfterAgent', session_id: 'gemini-messy', event_id: 'answer', prompt_response: 'We decided to rotate the leaked credential and retain the deployment logs.' },
      ]) {
        for (const event of adapter.normalize(input)) database_.append(event);
      }

      const session = database_.sessions(workspace.cwd).find(({ source }) => source === 'gemini');
      if (session === undefined) throw new Error('Expected a Gemini session.');
      const events = database_.eventsForSession(session.id);
      const storedTool = events.find(({ type }) => type === 'tool_result');
      expect(storedTool?.payload).toMatchObject({ output: { authorization: '[REDACTED]', output: largeOutput } });
      expect(renderContext(compileContext(events))).not.toContain('top-secret-token');
      expect(contextFor(database_, workspace.cwd, 'gemini').importantDecisions.map(({ value }) => value)).toEqual([
        'We decided to rotate the leaked credential and retain the deployment logs.',
      ]);
    } finally {
      database_.close();
    }
  });

  it('does not guess between concurrent Codex and Gemini sessions in one workspace', async () => {
    const database_ = await database();
    const workspace: WorkspaceState = { cwd: '/work/concurrent', gitHead: '123abc', gitStatus: '' };
    const codex = new CodexAdapter(() => workspace, () => '2026-08-20T03:23:00.000Z', () => 'codex-event');
    const gemini = new GeminiSourceAdapter(() => workspace, () => '2026-08-20T03:23:01.000Z', () => 'gemini-event');
    try {
      for (const event of codex.normalize({ hook_event_name: 'UserPromptSubmit', session_id: 'codex-concurrent', prompt: 'Investigate the failing test.' })) database_.append(event);
      for (const event of gemini.normalize({ hook_event_name: 'BeforeAgent', session_id: 'gemini-concurrent', prompt: 'Review the proposed fix.' })) database_.append(event);

      expect(database_.resolvedSession(workspace.cwd)).toBeUndefined();
      const geminiSession = database_.sessions(workspace.cwd).find(({ source }) => source === 'gemini');
      if (geminiSession === undefined) throw new Error('Expected a Gemini session.');
      database_.setActiveSession(workspace.cwd, geminiSession.id);
      expect(database_.resolvedSession(workspace.cwd)).toMatchObject({ id: geminiSession.id, source: 'gemini' });
      expect(contextFor(database_, workspace.cwd, 'gemini').currentObjective.value).toBe('Review the proposed fix.');
    } finally {
      database_.close();
    }
  });
});
