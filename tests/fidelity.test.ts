import { describe, expect, it } from 'vitest';

import { FixtureAdapter } from '../src/adapters/fixture.js';
import { compileContext } from '../src/context/compiler.js';
import { phaseZeroAcceptance, phaseZeroFidelityDimensions, scoreContextFidelity } from '../src/evals/fidelity.js';
import type { StoredEvent } from '../src/db/database.js';

describe('fixture-backed context fidelity', () => {
  it('recalls the current objective, constraint, decision, touched file, and failure', () => {
    const adapter = new FixtureAdapter();
    const rawEvents = [
      {
        schemaVersion: 1,
        id: 'fixture-1',
        sessionId: 'fixture-session',
        timestamp: '2026-08-19T12:00:00.000Z',
        source: 'fixture',
        type: 'user_message',
        payload: { text: 'Fix refresh concurrency. Do not change the public API.' },
        workspace: { cwd: '/work/payments' },
      },
      {
        schemaVersion: 1,
        id: 'fixture-2',
        sessionId: 'fixture-session',
        timestamp: '2026-08-19T12:01:00.000Z',
        source: 'fixture',
        type: 'assistant_message',
        payload: { text: 'We decided to serialize refreshes per session.' },
        workspace: { cwd: '/work/payments' },
      },
      {
        schemaVersion: 1,
        id: 'fixture-3',
        sessionId: 'fixture-session',
        timestamp: '2026-08-19T12:02:00.000Z',
        source: 'fixture',
        type: 'file_change',
        payload: { path: 'src/auth/refresh.ts' },
        workspace: { cwd: '/work/payments' },
      },
      {
        schemaVersion: 1,
        id: 'fixture-4',
        sessionId: 'fixture-session',
        timestamp: '2026-08-19T12:03:00.000Z',
        source: 'fixture',
        type: 'tool_result',
        payload: { output: 'refresh_concurrency failed with exit code 1' },
        workspace: { cwd: '/work/payments' },
      },
    ];

    const events: StoredEvent[] = adapter.replay(rawEvents).map((event, index) => ({ ...event, sequence: index + 1 }));
    const score = scoreContextFidelity(compileContext(events), [
      { facet: 'currentObjective', expected: 'Fix refresh concurrency. Do not change the public API.' },
      { facet: 'userRequirements', expected: 'Fix refresh concurrency. Do not change the public API.' },
      { facet: 'importantDecisions', expected: 'We decided to serialize refreshes per session.' },
      { facet: 'modifiedFiles', expected: 'src/auth/refresh.ts' },
      { facet: 'recentFailures', expected: 'refresh_concurrency failed with exit code 1' },
    ]);

    expect(adapter.name).toBe('fixture');
    expect(score).toEqual({ total: 5, passed: 5, failures: [] });
    expect(phaseZeroAcceptance.experimentalCurrentStateFidelityTarget).toBe(0.9);
    expect(phaseZeroAcceptance.zeroToleranceDimensions).toEqual(['obsolete_state_leakage', 'secret_leakage']);
    expect(phaseZeroFidelityDimensions).toContain('unresolved_question_recall');
    expect(phaseZeroFidelityDimensions).toContain('unsupported_fact_rate');
  });
});
