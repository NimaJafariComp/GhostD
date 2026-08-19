import { describe, expect, it } from 'vitest';

import { compileContext, renderContext } from '../src/context/compiler.js';
import type { StoredEvent } from '../src/db/database.js';

const events: StoredEvent[] = [
  {
    schemaVersion: 1,
    id: 'event-1',
    sessionId: 'codex-session-1',
    sequence: 1,
    timestamp: '2026-08-19T12:00:00.000Z',
    source: 'codex',
    type: 'user_message',
    trustClass: 'user',
    payload: { text: 'Implement session refresh. Do not change the public API.' },
    workspace: { cwd: '/work/payments-api', gitHead: 'abc123', gitStatus: '' },
  },
  {
    schemaVersion: 1,
    id: 'event-2',
    sessionId: 'codex-session-1',
    sequence: 2,
    timestamp: '2026-08-19T12:01:00.000Z',
    source: 'codex',
    type: 'assistant_message',
    trustClass: 'agent',
    payload: { text: 'We decided to use a per-session lock.' },
    workspace: { cwd: '/work/payments-api', gitHead: 'abc123', gitStatus: ' M src/auth/refresh.ts' },
  },
  {
    schemaVersion: 1,
    id: 'event-3',
    sessionId: 'codex-session-1',
    sequence: 3,
    timestamp: '2026-08-19T12:02:00.000Z',
    source: 'codex',
    type: 'file_change',
    trustClass: 'workspace',
    payload: { path: 'src/auth/refresh.ts' },
    workspace: { cwd: '/work/payments-api', gitHead: 'abc123', gitStatus: ' M src/auth/refresh.ts' },
  },
  {
    schemaVersion: 1,
    id: 'event-4',
    sessionId: 'codex-session-1',
    sequence: 4,
    timestamp: '2026-08-19T12:03:00.000Z',
    source: 'codex',
    type: 'tool_result',
    trustClass: 'tool',
    payload: { output: 'refresh_concurrency test failed intermittently with exit code 1' },
    workspace: { cwd: '/work/payments-api', gitHead: 'abc123', gitStatus: ' M src/auth/refresh.ts' },
  },
];

describe('compileContext', () => {
  it('creates a deterministic handoff from canonical events', () => {
    const context = compileContext(events);

    expect(context).toMatchObject({
      project: 'payments-api',
      agent: 'codex',
      currentObjective: {
        value: 'Implement session refresh. Do not change the public API.',
        sources: [{ eventId: 'event-1', sequence: 1, type: 'user_message', trustClass: 'user' }],
      },
      userRequirements: [{ value: 'Implement session refresh. Do not change the public API.' }],
      importantDecisions: [{ value: 'We decided to use a per-session lock.' }],
      modifiedFiles: [{ value: 'src/auth/refresh.ts' }],
      recentFailures: [{ value: 'refresh_concurrency test failed intermittently with exit code 1' }],
      workspace: { cwd: '/work/payments-api', gitHead: 'abc123', dirty: true },
    });

    expect(renderContext(context)).toContain('CURRENT OBJECTIVE');
    expect(renderContext(context)).toContain('dirty: yes');
    expect(renderContext(context, true)).toContain('[from: event-1]');
  });

  it('keeps only the active window after an explicit changed direction', () => {
    const changedDirection: StoredEvent[] = [
      {
        ...events[0]!,
        id: 'old-objective',
        sequence: 1,
        payload: { text: 'Implement blue mode. Do not change the public API.' },
      },
      {
        ...events[1]!,
        id: 'old-decision',
        sequence: 2,
        payload: { text: 'We decided to use blue mode.' },
      },
      {
        ...events[0]!,
        id: 'new-objective',
        sequence: 3,
        payload: { text: 'The user changed direction. Implement green mode instead. Do not use blue mode.' },
      },
      {
        ...events[1]!,
        id: 'new-decision',
        sequence: 4,
        payload: { text: 'We decided to use green mode.' },
        workspace: { cwd: '/work/payments-api', gitHead: 'abc123', gitStatus: '' },
      },
    ];

    const context = compileContext([...changedDirection].reverse());
    const rendered = renderContext(context);

    expect(context.currentObjective.value).toContain('green mode');
    expect(context.userRequirements.map(({ value }) => value)).toEqual([
      'The user changed direction. Implement green mode instead. Do not use blue mode.',
    ]);
    expect(context.importantDecisions.map(({ value }) => value)).toEqual(['We decided to use green mode.']);
    expect(context.modifiedFiles).toEqual([]);
    expect(rendered).not.toContain('We decided to use blue mode.');
  });

  it('uses the newest workspace snapshot instead of stale file-change events', () => {
    const context = compileContext([
      ...events,
      {
        ...events[3]!,
        id: 'event-5',
        sequence: 5,
        type: 'turn_end',
        trustClass: 'system',
        payload: { reason: 'completed' },
        workspace: { cwd: '/work/payments-api', gitHead: 'abc123', gitStatus: '' },
      },
    ]);

    expect(context.modifiedFiles).toEqual([]);
    expect(context.workspace.dirty).toBe(false);
  });
});
