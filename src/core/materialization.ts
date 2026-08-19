export const materializationModes = ['ephemeral', 'persistent'] as const;
export const materializationRunStatuses = ['running', 'succeeded', 'failed'] as const;
export const materializationStrategies = ['native_fork', 'session_resume', 'context_replay'] as const;

export type MaterializationMode = (typeof materializationModes)[number];
export type MaterializationRunStatus = (typeof materializationRunStatuses)[number];
export type MaterializationStrategy = (typeof materializationStrategies)[number];

export interface AgentCapabilities {
  provider: string;
  supportsNativeFork: boolean;
  supportsSessionResume: boolean;
  cacheScope: 'none' | 'request' | 'session';
  cacheLifetime: 'none' | 'ephemeral' | 'provider_managed';
  contextWindowTokens: number;
  workspaceAccess: 'none' | 'read_only' | 'read_write';
  toolAccess: 'none' | 'read_only' | 'read_write';
  writeAccess: boolean;
}

export interface MaterializationRun {
  id: string;
  branchId: string;
  provider: string;
  model: string;
  sourceRevisionId: string;
  mode: MaterializationMode;
  strategy: MaterializationStrategy;
  status: MaterializationRunStatus;
  materializationId?: string;
  providerHandle?: string;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
  latencyMs?: number;
  responseText?: string;
  recovery: string;
  failureCode?: string;
  createdAt: string;
  completedAt?: string;
}

export interface StartMaterializationRun {
  branchId: string;
  provider: string;
  model: string;
  sourceRevisionId: string;
  mode: MaterializationMode;
  strategy: MaterializationStrategy;
  createdAt: string;
}

export interface CompleteMaterializationRun {
  materializationId: string;
  providerHandle?: string;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
  latencyMs: number;
  responseText: string;
  completedAt: string;
}
