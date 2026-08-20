import { describe, expect, it } from 'vitest';

import { ClaudeSourceAdapter } from '../src/adapters/claude/source.js';
import type { WorkspaceState } from '../src/core/events.js';

const workspace: WorkspaceState = { cwd: '/work/ghost', gitHead: 'abc123', gitStatus: '' };

describe('ClaudeSourceAdapter', () => {
  it('normalizes hook-shaped Claude messages while preserving explicit temporal provenance', () => {
    const adapter = new ClaudeSourceAdapter(() => workspace, () => '2026-08-19T12:00:00.000Z', () => 'event-1');

    expect(adapter.normalize({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'claude-session',
      prompt: 'Use a SQLite ledger.',
      temporal: { relation: 'asserted', factId: 'ledger', kind: 'decision', value: 'Use a SQLite ledger.' },
    })).toEqual([expect.objectContaining({
      id: 'claude-claude-session-event-1',
      sessionId: 'claude-session',
      source: 'claude',
      type: 'user_message',
      trustClass: 'user',
      payload: {
        text: 'Use a SQLite ledger.',
        temporal: { relation: 'asserted', factId: 'ledger', kind: 'decision', value: 'Use a SQLite ledger.' },
      },
      workspace,
    })]);
  });

  it('ignores unsupported events and rejects missing session identifiers', () => {
    const adapter = new ClaudeSourceAdapter(() => workspace);

    expect(adapter.normalize({ hook_event_name: 'UnknownFutureEvent', session_id: 'claude-session' })).toEqual([]);
    expect(() => adapter.normalize({ hook_event_name: 'Stop' })).toThrow('missing session_id');
  });

  it('accepts documented streamed message-display events without reading a transcript', () => {
    const adapter = new ClaudeSourceAdapter(() => workspace, () => '2026-08-19T12:00:00.000Z', () => 'event-2');

    expect(adapter.normalize({
      hook_event_name: 'MessageDisplay',
      session_id: 'claude-session',
      delta: 'Final answer.',
      transcript_path: '/private/provider/transcript.jsonl',
    })).toEqual([
      expect.objectContaining({ type: 'assistant_message', payload: { text: 'Final answer.' } }),
    ]);
  });

  it('retains the documented SessionStart model signal without reading a transcript', () => {
    const adapter = new ClaudeSourceAdapter(() => workspace, () => '2026-08-20T12:00:00.000Z', () => 'event-model');

    expect(adapter.normalize({
      hook_event_name: 'SessionStart',
      session_id: 'claude-session',
      model: 'claude-sonnet-4-6',
      transcript_path: '/private/provider/transcript.jsonl',
    })).toEqual([
      expect.objectContaining({ type: 'session_start', payload: { claudeEvent: 'session_start', model: 'claude-sonnet-4-6' } }),
    ]);
  });

  it('uses documented provider error fields for failed tools and failed turns', () => {
    const adapter = new ClaudeSourceAdapter(() => workspace, () => '2026-08-19T12:00:00.000Z', () => 'event-3');

    expect(adapter.normalize({
      hook_event_name: 'PostToolUseFailure',
      session_id: 'claude-session',
      tool_name: 'Bash',
      error: 'Exit code 1\\nTests failed.',
    })).toEqual([
      expect.objectContaining({ type: 'tool_result', payload: { tool: 'Bash', output: 'Exit code 1\\nTests failed.' } }),
    ]);
    expect(adapter.normalize({
      hook_event_name: 'StopFailure',
      session_id: 'claude-session',
      error: 'rate_limit',
      error_details: '429 Too Many Requests',
    })).toEqual([
      expect.objectContaining({ type: 'turn_end', payload: { claudeEvent: 'turn_end', error: 'rate_limit', errorDetails: '429 Too Many Requests' } }),
    ]);
  });
});
