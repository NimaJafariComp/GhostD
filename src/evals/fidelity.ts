import type { CompiledContext, ContextFact } from '../context/compiler.js';

export type ContextFacet = 'currentObjective' | 'userRequirements' | 'importantDecisions' | 'modifiedFiles' | 'recentFailures';

export const phaseZeroFidelityDimensions = [
  'objective_recall',
  'constraint_recall',
  'decision_recall',
  'modified_file_recall',
  'failure_state_recall',
  'unresolved_question_recall',
  'git_state_recall',
  'obsolete_state_leakage',
  'secret_leakage',
  'unsupported_fact_rate',
] as const;

export type PhaseZeroFidelityDimension = (typeof phaseZeroFidelityDimensions)[number];

export const phaseZeroAcceptance = {
  experimentalCurrentStateFidelityTarget: 0.9,
  zeroToleranceDimensions: ['obsolete_state_leakage', 'secret_leakage'] as const satisfies readonly PhaseZeroFidelityDimension[],
} as const;

export interface FidelityExpectation {
  facet: ContextFacet;
  expected: string;
}

export interface FidelityResult {
  total: number;
  passed: number;
  failures: FidelityExpectation[];
}

function valuesFor(context: CompiledContext, facet: ContextFacet): readonly ContextFact[] {
  switch (facet) {
    case 'currentObjective':
      return [context.currentObjective];
    case 'userRequirements':
      return context.userRequirements;
    case 'importantDecisions':
      return context.importantDecisions;
    case 'modifiedFiles':
      return context.modifiedFiles;
    case 'recentFailures':
      return context.recentFailures;
  }
}

export function scoreContextFidelity(
  context: CompiledContext,
  expectations: readonly FidelityExpectation[],
): FidelityResult {
  const failures = expectations.filter(
    ({ expected, facet }) => !valuesFor(context, facet).some(({ value }) => value === expected),
  );
  return {
    total: expectations.length,
    passed: expectations.length - failures.length,
    failures,
  };
}
