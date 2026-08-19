import { describe, expect, it } from 'vitest';

import { temporalFacts } from '../src/core/temporal.js';
import type { StoredEvent } from '../src/db/database.js';

function event(id: string, sequence: number, temporal: Record<string, unknown>): StoredEvent {
  return {
    schemaVersion: 1,
    id,
    sessionId: 'session-1',
    sequence,
    timestamp: `2026-08-19T12:0${sequence}:00.000Z`,
    source: 'fixture',
    type: 'assistant_message',
    trustClass: 'agent',
    payload: { temporal },
    workspace: { cwd: '/work/ghost' },
  };
}

describe('temporal facts', () => {
  it('tracks every supported fact kind through explicit supersession, reaffirmation, and invalidation', () => {
    const facts = temporalFacts([
      event('constraint-old', 1, { relation: 'asserted', factId: 'constraint-old', kind: 'constraint', value: 'Use blue.' }),
      event('constraint-new', 2, {
        relation: 'supersedes',
        factId: 'constraint-new',
        targetFactId: 'constraint-old',
        kind: 'constraint',
        value: 'Use green.',
      }),
      event('decision', 3, { relation: 'asserted', factId: 'ledger', kind: 'decision', value: 'Use SQLite.' }),
      event('decision-reaffirmed', 4, { relation: 'reaffirmed', targetFactId: 'ledger' }),
      event('assumption', 5, { relation: 'asserted', factId: 'assumption', kind: 'assumption', value: 'Cache is warm.' }),
      event('assumption-invalidated', 6, { relation: 'invalidates', targetFactId: 'assumption' }),
      event('failure', 7, { relation: 'asserted', factId: 'failure', kind: 'failure', value: 'Migration failed.' }),
      event('hypothesis', 8, { relation: 'asserted', factId: 'hypothesis', kind: 'hypothesis', value: 'Locking causes the failure.' }),
      event('hypothesis-invalidated', 9, { relation: 'invalidates', targetFactId: 'hypothesis' }),
    ]);

    expect(facts).toEqual([
      expect.objectContaining({ id: 'constraint-old', kind: 'constraint', state: 'superseded', supersededBy: 'constraint-new' }),
      expect.objectContaining({ id: 'constraint-new', kind: 'constraint', state: 'active' }),
      expect.objectContaining({ id: 'ledger', kind: 'decision', state: 'reaffirmed', sourceEventIds: ['decision', 'decision-reaffirmed'] }),
      expect.objectContaining({ id: 'assumption', kind: 'assumption', state: 'invalidated', invalidatedBy: 'assumption-invalidated' }),
      expect.objectContaining({ id: 'failure', kind: 'failure', state: 'active' }),
      expect.objectContaining({ id: 'hypothesis', kind: 'hypothesis', state: 'invalidated', invalidatedBy: 'hypothesis-invalidated' }),
    ]);
  });

  it('ignores malformed temporal metadata rather than guessing unsupported state transitions', () => {
    expect(temporalFacts([
      event('unsupported', 1, { relation: 'invalidates', targetFactId: 42 }),
      event('missing-value', 2, { relation: 'asserted', factId: 'missing-value', kind: 'decision' }),
    ])).toEqual([]);
  });
});
