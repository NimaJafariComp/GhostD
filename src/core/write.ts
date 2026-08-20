export const writeWorktreeLifecycles = ['active', 'closed'] as const;
export const writePromotionStatuses = ['pending', 'succeeded', 'failed'] as const;

export type WriteWorktreeLifecycle = (typeof writeWorktreeLifecycles)[number];
export type WritePromotionStatus = (typeof writePromotionStatuses)[number];

/** An isolated, Git-backed writable replica attached to one logical Ghost branch. */
export interface WriteWorktree {
  id: string;
  branchId: string;
  repositoryPath: string;
  worktreePath: string;
  gitBranch: string;
  baseCommit: string;
  lifecycle: WriteWorktreeLifecycle;
  createdAt: string;
  closedAt?: string;
}

/** Reproducible patch identity. Patch bytes are never persisted in Ghost storage. */
export interface PatchProvenance {
  id: string;
  worktreeId: string;
  baseCommit: string;
  headCommit: string;
  diffSha256: string;
  changedFileCount: number;
  createdAt: string;
}

/** An explicit, user-approved promotion attempt. */
export interface WritePromotion {
  id: string;
  worktreeId: string;
  patchId: string;
  targetGitBranch: string;
  sourceCommit: string;
  targetBeforeCommit: string;
  status: WritePromotionStatus;
  targetAfterCommit?: string;
  failureCode?: string;
  createdAt: string;
  completedAt?: string;
}

export interface WorktreeStatus {
  worktree: WriteWorktree;
  headCommit: string;
  isClean: boolean;
  changedFileCount: number;
  diffStat: string;
  patches: PatchProvenance[];
}
