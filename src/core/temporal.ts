import type { StoredEvent } from '../db/database.js';

export const temporalFactKinds = ['constraint', 'decision', 'assumption', 'failure', 'hypothesis'] as const;
export const temporalFactStates = ['active', 'reaffirmed', 'superseded', 'invalidated'] as const;

export type TemporalFactKind = (typeof temporalFactKinds)[number];
export type TemporalFactState = (typeof temporalFactStates)[number];

export interface TemporalFact {
  id: string;
  kind: TemporalFactKind;
  value: string;
  state: TemporalFactState;
  sourceEventIds: string[];
  supersededBy?: string;
  invalidatedBy?: string;
}

interface TemporalRelation {
  relation: 'asserted' | 'reaffirmed' | 'supersedes' | 'invalidates';
  factId?: string;
  targetFactId?: string;
  kind?: TemporalFactKind;
  value?: string;
}

/**
 * Derives temporal facts only from explicit canonical payload metadata. Natural-language
 * statements remain provenance, but never become guessed invalidations or supersessions.
 */
export function temporalFacts(events: StoredEvent[]): TemporalFact[] {
  const facts = new Map<string, TemporalFact>();
  for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
    const relation = temporalRelation(event.payload['temporal']);
    if (relation === undefined) {
      continue;
    }
    switch (relation.relation) {
      case 'asserted':
        assertFact(facts, relation, event.id);
        break;
      case 'reaffirmed':
        reaffirmFact(facts, relation.targetFactId, event.id);
        break;
      case 'supersedes':
        supersedeFact(facts, relation, event.id);
        break;
      case 'invalidates':
        invalidateFact(facts, relation.targetFactId, event.id);
        break;
    }
  }
  return [...facts.values()];
}

function temporalRelation(value: unknown): TemporalRelation | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const relation = value['relation'];
  if (relation !== 'asserted' && relation !== 'reaffirmed' && relation !== 'supersedes' && relation !== 'invalidates') {
    return undefined;
  }
  const factId = nonEmptyString(value['factId']);
  const targetFactId = nonEmptyString(value['targetFactId']);
  const kind = value['kind'];
  const parsedKind = typeof kind === 'string' && temporalFactKinds.includes(kind as TemporalFactKind)
    ? kind as TemporalFactKind
    : undefined;
  const parsedValue = nonEmptyString(value['value']);
  if ((relation === 'asserted' || relation === 'supersedes') && (factId === undefined || parsedKind === undefined || parsedValue === undefined)) {
    return undefined;
  }
  if ((relation === 'reaffirmed' || relation === 'invalidates' || relation === 'supersedes') && targetFactId === undefined) {
    return undefined;
  }
  return {
    relation,
    ...(factId === undefined ? {} : { factId }),
    ...(targetFactId === undefined ? {} : { targetFactId }),
    ...(parsedKind === undefined ? {} : { kind: parsedKind }),
    ...(parsedValue === undefined ? {} : { value: parsedValue }),
  };
}

function assertFact(facts: Map<string, TemporalFact>, relation: TemporalRelation, eventId: string): void {
  if (relation.factId === undefined || relation.kind === undefined || relation.value === undefined || facts.has(relation.factId)) {
    return;
  }
  facts.set(relation.factId, {
    id: relation.factId,
    kind: relation.kind,
    value: relation.value,
    state: 'active',
    sourceEventIds: [eventId],
  });
}

function reaffirmFact(facts: Map<string, TemporalFact>, targetFactId: string | undefined, eventId: string): void {
  if (targetFactId === undefined) {
    return;
  }
  const existing = facts.get(targetFactId);
  if (existing === undefined || existing.state === 'superseded' || existing.state === 'invalidated') {
    return;
  }
  existing.state = 'reaffirmed';
  existing.sourceEventIds.push(eventId);
}

function supersedeFact(facts: Map<string, TemporalFact>, relation: TemporalRelation, eventId: string): void {
  if (relation.targetFactId === undefined || relation.factId === undefined || relation.kind === undefined || relation.value === undefined) {
    return;
  }
  const target = facts.get(relation.targetFactId);
  if (target === undefined || target.state === 'superseded' || target.state === 'invalidated') {
    return;
  }
  target.state = 'superseded';
  target.supersededBy = relation.factId;
  assertFact(facts, relation, eventId);
}

function invalidateFact(facts: Map<string, TemporalFact>, targetFactId: string | undefined, eventId: string): void {
  if (targetFactId === undefined) {
    return;
  }
  const target = facts.get(targetFactId);
  if (target === undefined || target.state === 'superseded' || target.state === 'invalidated') {
    return;
  }
  target.state = 'invalidated';
  target.invalidatedBy = eventId;
  target.sourceEventIds.push(eventId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
