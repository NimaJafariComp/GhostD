import { describe, expect, it } from 'vitest';

import { AntigravitySourceAdapter } from '../src/adapters/antigravity/source.js';

describe('AntigravitySourceAdapter', () => {
  const adapter = new AntigravitySourceAdapter(
    (cwd) => ({ cwd, gitHead: `head-${cwd}`, gitStatus: '' }),
    () => '2026-08-20T12:00:00.000Z',
    () => 'generated',
  );

  it('captures only documented lifecycle metadata without reading transcript or artifact paths', () => {
    expect(adapter.normalize({
      hookEventName: 'PreInvocation',
      conversationId: 'antigravity-session',
      workspacePaths: ['/work/ghost'],
      invocationNum: 3,
      transcriptPath: '/private/transcript.jsonl',
      artifactDirectoryPath: '/private/artifacts',
    })).toEqual([expect.objectContaining({
      id: 'antigravity-antigravity-session-_work_ghost-PreInvocation-3',
      source: 'antigravity',
      sessionId: 'antigravity-session',
      type: 'session_start',
      trustClass: 'system',
      payload: { antigravityEvent: 'PreInvocation', invocationNumber: 3 },
      workspace: { cwd: '/work/ghost', gitHead: 'head-/work/ghost', gitStatus: '' },
    })]);
  });

  it('keeps every declared workspace separate and preserves documented tool failures', () => {
    expect(adapter.normalize({
      hookEventName: 'PostToolUse',
      conversationId: 'antigravity-session',
      workspacePaths: ['/work/one', '/work/two'],
      stepIdx: 4,
      toolCall: { name: 'run_command', args: { CommandLine: 'npm test' } },
      error: 'exit status 1',
    })).toEqual([
      expect.objectContaining({
        type: 'tool_result',
        payload: { antigravityEvent: 'PostToolUse', tool: 'run_command', input: { CommandLine: 'npm test' }, output: 'exit status 1' },
        workspace: { cwd: '/work/one', gitHead: 'head-/work/one', gitStatus: '' },
      }),
      expect.objectContaining({
        type: 'tool_result',
        workspace: { cwd: '/work/two', gitHead: 'head-/work/two', gitStatus: '' },
      }),
    ]);
  });

  it('does not close a session while Antigravity reports background work', () => {
    expect(adapter.normalize({
      hookEventName: 'Stop',
      conversationId: 'antigravity-session',
      workspacePaths: ['/work/ghost'],
      fullyIdle: false,
      terminationReason: 'model_stop',
    })[0]).toMatchObject({ type: 'turn_end', payload: { antigravityEvent: 'Stop', fullyIdle: false } });

    expect(adapter.normalize({
      hookEventName: 'Stop',
      conversationId: 'antigravity-session',
      workspacePaths: ['/work/ghost'],
      fullyIdle: true,
      terminationReason: 'error',
      error: 'provider unavailable',
    })[0]).toMatchObject({
      type: 'session_end',
      payload: { antigravityEvent: 'Stop', reason: 'error', error: 'provider unavailable', fullyIdle: true },
    });
  });

  it('rejects missing identity or ambiguous non-absolute workspace input', () => {
    expect(() => adapter.normalize({ hookEventName: 'PostInvocation', workspacePaths: ['/work/ghost'] })).toThrow('conversationId');
    expect(() => adapter.normalize({ hookEventName: 'PostInvocation', conversationId: 'antigravity-session', workspacePaths: ['relative'] })).toThrow('absolute workspacePaths');
  });
});
