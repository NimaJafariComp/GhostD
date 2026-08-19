export const branchLifecycles = ['open', 'closed'] as const;
export const branchPersistences = ['persistent', 'ephemeral'] as const;

export type BranchLifecycle = (typeof branchLifecycles)[number];
export type BranchPersistence = (typeof branchPersistences)[number];

export interface WorkspaceSnapshot {
  id: string;
  cwd: string;
  gitHead?: string;
  gitStatus?: string;
}

export interface GhostRevision {
  id: string;
  parentRevisionId?: string;
  sessionId: string;
  eventHighWaterMark: number;
  workspaceSnapshotId: string;
  createdAt: string;
}

export interface GhostBranch {
  id: string;
  name: string;
  persistence: BranchPersistence;
  lifecycle: BranchLifecycle;
  baseRevisionId: string;
  headRevisionId: string;
  trackingRevisionId: string;
  originatingSessionId: string;
  createdAt: string;
  closedAt?: string;
}

export interface BranchMaterialization {
  id: string;
  branchId: string;
  provider: string;
  providerHandle?: string;
  synchronizedRevisionId: string;
  createdAt: string;
  updatedAt: string;
}

export interface MaterializationStatus {
  materialization: BranchMaterialization;
  stale: boolean;
}

export interface BranchSynchronizationStatus {
  branch: GhostBranch;
  latestRevision: GhostRevision;
  pendingEventCount: number;
  rebaseRequired: boolean;
  staleMaterializationCount: number;
}

export interface BranchRebase {
  id: string;
  branchId: string;
  fromRevisionId: string;
  toRevisionId: string;
  addedEventCount: number;
  createdAt: string;
}

export interface RebaseResult {
  branch: GhostBranch;
  latestRevision: GhostRevision;
  addedEventCount: number;
  rebased: boolean;
  rebase?: BranchRebase;
}
