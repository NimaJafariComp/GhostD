import { describe, expect, it } from 'vitest';

import { GeminiSourceAdapter } from '../src/adapters/gemini/source.js';
import type { WorkspaceState } from '../src/core/events.js';

const workspace: WorkspaceState = { cwd: '/work/ghost', gitHead: 'abc123', gitStatus: '' };

describe('GeminiSourceAdapter', () => {
  it('normalizes hook-shaped Gemini input without provider transcript access', () => {
    const adapter = new GeminiSourceAdapter(() => workspace, () => '2026-08-19T12:00:00.000Z', () => 'event-1');

    expect(adapter.normalize({
      hook_event_name: 'ModelResponse',
      session_id: 'gemini-session',
      text: 'Use immutable revisions.',
    })).toEqual([expect.objectContaining({
      id: 'gemini-gemini-session-event-1',
      source: 'gemini',
      type: 'assistant_message',
      trustClass: 'agent',
      payload: { text: 'Use immutable revisions.' },
      workspace,
    })]);
  });

  it('ignores unsupported events and rejects missing session identifiers for supported events', () => {
    const adapter = new GeminiSourceAdapter(() => workspace);

    expect(adapter.normalize({ hook_event_name: 'FutureEvent', session_id: 'gemini-session' })).toEqual([]);
    expect(() => adapter.normalize({ hook_event_name: 'Stop' })).toThrow('missing session_id');
  });
});
