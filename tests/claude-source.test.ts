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

    expect(adapter.normalize({ hook_event_name: 'MessageDisplay', session_id: 'claude-session', text: 'Final answer.' })).toEqual([
      expect.objectContaining({ type: 'assistant_message', payload: { text: 'Final answer.' } }),
    ]);
  });
});
