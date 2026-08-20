export const comparisonRunStatuses = ['running', 'succeeded', 'partial', 'failed'] as const;
export const comparisonParticipantStatuses = ['running', 'succeeded', 'failed'] as const;
export const insightKinds = ['finding', 'evidence', 'recommendation'] as const;

export type ComparisonRunStatus = (typeof comparisonRunStatuses)[number];
export type ComparisonParticipantStatus = (typeof comparisonParticipantStatuses)[number];
export type InsightKind = (typeof insightKinds)[number];

export interface ComparisonRun {
  id: string;
  branchId: string;
  frozenRevisionId: string;
  workspaceSnapshotId: string;
  prompt: string;
  status: ComparisonRunStatus;
  createdAt: string;
  completedAt?: string;
}

export interface ComparisonParticipant {
  id: string;
  comparisonRunId: string;
  provider: string;
  model: string;
  status: ComparisonParticipantStatus;
  providerHandle?: string;
  responseText?: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  failureCode?: string;
  createdAt: string;
  completedAt?: string;
}

export interface ComparisonInsight {
  id: string;
  comparisonRunId: string;
  participantId: string;
  kind: InsightKind;
  text: string;
  eventIds: string[];
  createdAt: string;
}

export interface InsightPayload {
  findings: string[];
  evidence: Array<{ text: string; eventIds: string[] }>;
  recommendations: string[];
}

export interface BranchCopy {
  id: string;
  sourceBranchId: string;
  copiedBranchId: string;
  revisionId: string;
  createdAt: string;
}

export interface BranchMerge {
  id: string;
  sourceBranchId: string;
  targetBranchId: string;
  fromRevisionId: string;
  toRevisionId: string;
  createdAt: string;
}

export interface BranchMergeResult {
  targetBranchId: string;
  headRevisionId: string;
  merged: boolean;
  merge?: BranchMerge;
}

export interface AgentSwitch {
  id: string;
  branchId: string;
  targetAgent: string;
  revisionId: string;
  createdAt: string;
}
