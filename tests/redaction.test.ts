import { describe, expect, it } from 'vitest';

import type { GhostEvent } from '../src/core/events.js';
import { redactEvent } from '../src/privacy/redaction.js';

const event: GhostEvent = {
  schemaVersion: 1,
  id: 'secret-event',
  sessionId: 'session-1',
  timestamp: '2026-08-19T12:00:00.000Z',
  source: 'codex',
  type: 'tool_result',
  trustClass: 'tool',
  payload: {
    output: 'Authorization: Bearer token-value; API key: visible-key; sk-abcdefghijklmnop; ghp_abcdefghijklmnopqrst',
    nested: { password: 'super-secret' },
    items: [{ token: 'nested-token' }, 'Bearer another-token'],
  },
  workspace: { cwd: '/work/ghost' },
};

describe('redactEvent', () => {
  it('redacts inline and nested storage credentials without mutating the canonical input', () => {
    const result = redactEvent(event, 'storage');

    expect(result.redacted).toBe(true);
    expect(result.value.payload).toEqual({
      output: 'Authorization: [REDACTED]; API key: [REDACTED]; [REDACTED]; [REDACTED]',
      nested: { password: '[REDACTED]' },
      items: [{ token: '[REDACTED]' }, 'Bearer [REDACTED]'],
    });
    expect(event.payload.nested).toEqual({ password: 'super-secret' });
  });

  it('honors a policy that deliberately disables inline redaction', () => {
    const result = redactEvent(event, 'remote', {
      marker: '[MASKED]',
      redactSensitiveFields: false,
      redactInlineCredentials: false,
    });

    expect(result).toEqual({ value: event, redacted: false });
  });

  it('redacts an incomplete private-key block rather than retaining a partial credential', () => {
    const result = redactEvent({
      ...event,
      payload: { output: 'before\n-----BEGIN PRIVATE KEY-----\npartial-key-material' },
    }, 'storage');

    expect(result.value.payload).toEqual({ output: 'before\n[REDACTED]' });
  });
});
