import { randomUUID } from 'node:crypto';

import type { GhostRevision, WorkspaceSnapshot } from '../core/graph.js';
import type { GhostBranch } from '../core/graph.js';
import type { PatchProvenance, WorktreeStatus, WritePromotion, WriteWorktree } from '../core/write.js';
import { GhostDatabase } from '../db/database.js';
import { GitWorktreeManager } from '../workspace/worktree.js';

export class WriteBranchService {
  public constructor(
    private readonly database: GhostDatabase,
    private readonly worktrees: GitWorktreeManager = new GitWorktreeManager(),
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  public async create(branchName: string): Promise<WriteWorktree> {
    const branch = this.requireOpenBranch(branchName);
    if (this.database.writeWorktreeForBranch(branchName) !== undefined) {
      throw new Error(`Branch ${branchName} already has a write worktree.`);
    }
    const revision = this.requireRevision(branch);
    const snapshot = this.requireSnapshot(revision);
    if (snapshot.gitHead === undefined) {
      throw new Error('The Ghost workspace snapshot has no Git commit; capture a Git workspace before creating a write worktree.');
    }
    const id = randomUUID();
    const gitBranch = `ghostd/${branch.id}`;
    const created = await this.worktrees.create({
      repositoryCwd: snapshot.cwd,
      worktreeId: id,
      gitBranch,
      baseCommit: snapshot.gitHead,
    });
    try {
      return this.database.createWriteWorktree({ id, branchId: branch.id, ...created, createdAt: this.now() });
    } catch (error: unknown) {
      await this.worktrees.remove(created).catch(() => undefined);
      throw error;
    }
  }

  public async status(branchName: string): Promise<WorktreeStatus> {
    const worktree = this.requireActiveWorktree(branchName);
    const inspection = await this.worktrees.inspect(worktree);
    return { worktree, ...inspection, patches: this.database.patchProvenanceForBranch(branchName) };
  }

  public async diff(branchName: string): Promise<string> {
    const worktree = this.requireActiveWorktree(branchName);
    const patch = await this.worktrees.patch(worktree);
    return patch?.diff ?? '';
  }

  public async promote(branchName: string, targetGitBranch: string, approved: boolean): Promise<WritePromotion> {
    if (!approved) {
      throw new Error('Promotion requires the explicit --approve flag.');
    }
    const worktree = this.requireActiveWorktree(branchName);
    const patch = await this.worktrees.patch(worktree);
    if (patch === undefined) {
      throw new Error('The write worktree has no committed patch to promote.');
    }
    const provenance = this.recordPatch(worktree, patch);
    const promotion = await this.worktrees.promote(worktree, targetGitBranch);
    return this.database.recordWritePromotion({
      worktreeId: worktree.id,
      patchId: provenance.id,
      targetGitBranch,
      sourceCommit: patch.headCommit,
      targetBeforeCommit: promotion.targetBeforeCommit,
      targetAfterCommit: promotion.targetAfterCommit,
      createdAt: this.now(),
    });
  }

  public async close(branchName: string): Promise<{ worktree: WriteWorktree; patch?: PatchProvenance }> {
    const worktree = this.requireActiveWorktree(branchName);
    const patch = await this.worktrees.patch(worktree);
    const provenance = patch === undefined ? undefined : this.recordPatch(worktree, patch);
    await this.worktrees.remove(worktree);
    return { worktree: this.database.closeWriteWorktree(branchName, this.now()), ...(provenance === undefined ? {} : { patch: provenance }) };
  }

  private recordPatch(worktree: WriteWorktree, patch: { baseCommit: string; headCommit: string; diffSha256: string; changedFileCount: number }): PatchProvenance {
    return this.database.recordPatchProvenance({ worktreeId: worktree.id, ...patch, createdAt: this.now() });
  }

  private requireOpenBranch(name: string): GhostBranch {
    const branch = this.database.branch(name);
    if (branch === undefined || branch.lifecycle !== 'open') {
      throw new Error(`Branch ${name} must be open to create a write worktree.`);
    }
    return branch;
  }

  private requireActiveWorktree(name: string): WriteWorktree {
    const worktree = this.database.writeWorktreeForBranch(name);
    if (worktree === undefined || worktree.lifecycle !== 'active') {
      throw new Error(`Branch ${name} has no active write worktree.`);
    }
    return worktree;
  }

  private requireRevision(branch: GhostBranch): GhostRevision {
    const revision = this.database.revision(branch.headRevisionId);
    if (revision === undefined) {
      throw new Error(`Branch ${branch.name} references a missing revision.`);
    }
    return revision;
  }

  private requireSnapshot(revision: GhostRevision): WorkspaceSnapshot {
    const snapshot = this.database.workspaceSnapshot(revision.workspaceSnapshotId);
    if (snapshot === undefined) {
      throw new Error(`Revision ${revision.id} references a missing workspace snapshot.`);
    }
    return snapshot;
  }
}
