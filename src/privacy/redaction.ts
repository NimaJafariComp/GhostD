import type { GhostEvent } from '../core/events.js';

export type RedactionScope = 'storage' | 'remote';

export interface RedactionPolicy {
  marker: string;
  redactSensitiveFields: boolean;
  redactInlineCredentials: boolean;
}

export const defaultRedactionPolicies: Readonly<Record<RedactionScope, RedactionPolicy>> = {
  storage: {
    marker: '[REDACTED]',
    redactSensitiveFields: true,
    redactInlineCredentials: true,
  },
  remote: {
    marker: '[REDACTED]',
    redactSensitiveFields: true,
    redactInlineCredentials: true,
  },
};

const sensitiveField = /(?:api[\s_-]?key|authorization|credential|password|private[\s_-]?key|secret|token)/i;
const privateKeyBlock = /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----[\s\S]*?(?:-----END(?: [A-Z]+)? PRIVATE KEY-----|$)/g;
const bearerToken = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const knownToken = /\b(?:sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b/g;
const authorizationAssignment = /\bauthorization\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi;
const namedAssignment = /\b((?:api[\s_-]?key|authorization|credential|password|private[\s_-]?key|secret|token)\s*[:=]\s*)([^\s,;]+)/gi;

export interface RedactionResult<T> {
  value: T;
  redacted: boolean;
}

function redactString(value: string, policy: RedactionPolicy): RedactionResult<string> {
  if (!policy.redactInlineCredentials) {
    return { value, redacted: false };
  }

  const redacted = value
    .replace(privateKeyBlock, policy.marker)
    .replace(authorizationAssignment, `Authorization: ${policy.marker}`)
    .replace(bearerToken, `Bearer ${policy.marker}`)
    .replace(knownToken, policy.marker)
    .replace(namedAssignment, `$1${policy.marker}`);
  return { value: redacted, redacted: redacted !== value };
}

function redactUnknown(value: unknown, policy: RedactionPolicy, inheritedSensitive: boolean): RedactionResult<unknown> {
  if (typeof value === 'string') {
    if (inheritedSensitive && policy.redactSensitiveFields) {
      return { value: policy.marker, redacted: true };
    }
    return redactString(value, policy);
  }

  if (Array.isArray(value)) {
    let redacted = false;
    const items = value.map((item) => {
      const result = redactUnknown(item, policy, inheritedSensitive);
      redacted ||= result.redacted;
      return result.value;
    });
    return { value: items, redacted };
  }

  if (typeof value === 'object' && value !== null) {
    let redacted = false;
    const record: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      const result = redactUnknown(nested, policy, inheritedSensitive || sensitiveField.test(key));
      redacted ||= result.redacted;
      record[key] = result.value;
    }
    return { value: record, redacted };
  }

  return { value, redacted: false };
}

export function redactEvent(
  event: GhostEvent,
  scope: RedactionScope,
  policy: RedactionPolicy = defaultRedactionPolicies[scope],
): RedactionResult<GhostEvent> {
  const payload = redactUnknown(event.payload, policy, false);
  return {
    value: {
      ...event,
      payload: payload.value as Record<string, unknown>,
    },
    redacted: payload.redacted,
  };
}
