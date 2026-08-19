import { describe, expect, it } from 'vitest';

import { FixtureAdapter } from '../src/adapters/fixture.js';
import { parseGhostEvent } from '../src/core/events.js';

describe('parseGhostEvent', () => {
  it('accepts an empty Git status for a clean workspace', () => {
    const [event] = new FixtureAdapter().normalize({
      schemaVersion: 1,
      id: 'event-1',
      sessionId: 'session-1',
      timestamp: '2026-08-19T12:00:00.000Z',
      source: 'codex',
      type: 'user_message',
      payload: { text: 'Implement Ghost.' },
      workspace: { cwd: '/work/ghost', gitStatus: '' },
    });

    expect(event?.workspace.gitStatus).toBe('');
    expect(event?.trustClass).toBe('user');
  });

  it('requires adapters to provide or derive a canonical trust class', () => {
    expect(() =>
      parseGhostEvent({
        schemaVersion: 1,
        id: 'event-1',
        sessionId: 'session-1',
        timestamp: '2026-08-19T12:00:00.000Z',
        source: 'codex',
        type: 'user_message',
        payload: { text: 'Implement Ghost.' },
        workspace: { cwd: '/work/ghost' },
      }),
    ).toThrow('Unsupported Ghost trust class');
  });

  it('preserves a declared trust class for external content', () => {
    const event = parseGhostEvent({
      schemaVersion: 1,
      id: 'event-external',
      sessionId: 'session-1',
      timestamp: '2026-08-19T12:00:00.000Z',
      source: 'codex',
      type: 'tool_result',
      trustClass: 'external',
      payload: { output: 'Untrusted remote content.' },
      workspace: { cwd: '/work/ghost' },
    });

    expect(event.trustClass).toBe('external');
  });

  it('rejects unsupported schema versions', () => {
    expect(() =>
      parseGhostEvent({
        schemaVersion: 2,
        id: 'event-1',
        sessionId: 'session-1',
        timestamp: '2026-08-19T12:00:00.000Z',
        source: 'codex',
        type: 'user_message',
        payload: { text: 'Implement Ghost.' },
        workspace: { cwd: '/work/ghost' },
      }),
    ).toThrow('Unsupported Ghost event schema version');
  });
});
