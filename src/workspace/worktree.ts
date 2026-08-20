import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GitWorktreeCreateInput {
  repositoryCwd: string;
  worktreeId: string;
  gitBranch: string;
  baseCommit: string;
}

export interface GitWorktree {
  repositoryPath: string;
  worktreePath: string;
  gitBranch: string;
  baseCommit: string;
}

export interface GitWorktreeInspection {
  headCommit: string;
  isClean: boolean;
  changedFileCount: number;
  diffStat: string;
}

export interface GitPatch {
  baseCommit: string;
  headCommit: string;
  diffSha256: string;
  changedFileCount: number;
  diff: string;
}

export interface GitPromotion {
  targetBeforeCommit: string;
  targetAfterCommit: string;
}

/** Runs Git through argument arrays only; branch names and paths are never evaluated by a shell. */
export class GitWorktreeManager {
  private readonly root: string;

  public constructor(root = process.env['GHOST_WORKTREE_ROOT'] ?? join(homedir(), '.ghost', 'worktrees')) {
    this.root = resolve(root);
  }

  public async create(input: GitWorktreeCreateInput): Promise<GitWorktree> {
    const repositoryPath = await this.repositoryRoot(input.repositoryCwd);
    const currentHead = await this.git(repositoryPath, ['rev-parse', 'HEAD']);
    if (currentHead !== input.baseCommit) {
      throw new Error('The repository HEAD no longer matches the Ghost workspace snapshot; capture or rebase before creating a write worktree.');
    }
    await this.requireClean(repositoryPath, 'repository');
    await this.requireCommit(repositoryPath, input.baseCommit);
    const worktreePath = this.managedPath(repositoryPath, input.worktreeId);
    await mkdir(dirname(worktreePath), { recursive: true });
    await this.git(repositoryPath, ['worktree', 'add', '-b', input.gitBranch, worktreePath, input.baseCommit]);
    return { repositoryPath, worktreePath, gitBranch: input.gitBranch, baseCommit: input.baseCommit };
  }

  public async inspect(worktree: GitWorktree): Promise<GitWorktreeInspection> {
    this.assertManagedPath(worktree.worktreePath);
    const [headCommit, status, names, diffStat] = await Promise.all([
      this.git(worktree.worktreePath, ['rev-parse', 'HEAD']),
      this.git(worktree.worktreePath, ['status', '--porcelain']),
      this.git(worktree.worktreePath, ['diff', '--name-only', `${worktree.baseCommit}..HEAD`]),
      this.git(worktree.worktreePath, ['diff', '--stat', `${worktree.baseCommit}..HEAD`]),
    ]);
    return {
      headCommit,
      isClean: status.length === 0,
      changedFileCount: countLines(names),
      diffStat,
    };
  }

  public async patch(worktree: GitWorktree): Promise<GitPatch | undefined> {
    this.assertManagedPath(worktree.worktreePath);
    await this.requireClean(worktree.worktreePath, 'write worktree');
    const headCommit = await this.git(worktree.worktreePath, ['rev-parse', 'HEAD']);
    await this.requireAncestor(worktree.worktreePath, worktree.baseCommit, headCommit, 'The write branch no longer descends from its captured base commit.');
    const diff = await this.git(worktree.worktreePath, ['diff', '--binary', `${worktree.baseCommit}..${headCommit}`]);
    if (diff.length === 0) {
      return undefined;
    }
    const names = await this.git(worktree.worktreePath, ['diff', '--name-only', `${worktree.baseCommit}..${headCommit}`]);
    return {
      baseCommit: worktree.baseCommit,
      headCommit,
      diffSha256: createHash('sha256').update(diff).digest('hex'),
      changedFileCount: countLines(names),
      diff,
    };
  }

  public async promote(worktree: GitWorktree, targetGitBranch: string): Promise<GitPromotion> {
    if (!isGitRefName(targetGitBranch)) {
      throw new Error('The target Git branch name is invalid.');
    }
    await this.requireClean(worktree.worktreePath, 'write worktree');
    await this.requireClean(worktree.repositoryPath, 'target repository');
    const checkedOut = await this.git(worktree.repositoryPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (checkedOut !== targetGitBranch) {
      throw new Error(`The target repository must have ${targetGitBranch} checked out before promotion.`);
    }
    const [sourceCommit, targetBeforeCommit] = await Promise.all([
      this.git(worktree.worktreePath, ['rev-parse', 'HEAD']),
      this.git(worktree.repositoryPath, ['rev-parse', targetGitBranch]),
    ]);
    await this.requireAncestor(worktree.repositoryPath, targetBeforeCommit, sourceCommit, 'Promotion would not fast-forward the target branch; resolve it manually.');
    await this.git(worktree.repositoryPath, ['merge', '--ff-only', worktree.gitBranch]);
    const targetAfterCommit = await this.git(worktree.repositoryPath, ['rev-parse', 'HEAD']);
    return { targetBeforeCommit, targetAfterCommit };
  }

  public async remove(worktree: GitWorktree): Promise<void> {
    this.assertManagedPath(worktree.worktreePath);
    await this.requireClean(worktree.worktreePath, 'write worktree');
    await this.git(worktree.repositoryPath, ['worktree', 'remove', worktree.worktreePath]);
  }

  private async repositoryRoot(cwd: string): Promise<string> {
    return this.git(cwd, ['rev-parse', '--show-toplevel']);
  }

  private managedPath(repositoryPath: string, worktreeId: string): string {
    const repositoryKey = createHash('sha256').update(repositoryPath).digest('hex').slice(0, 16);
    const path = resolve(this.root, repositoryKey, worktreeId);
    this.assertManagedPath(path);
    return path;
  }

  private assertManagedPath(path: string): void {
    const resolved = resolve(path);
    const pathWithinRoot = relative(this.root, resolved);
    if (pathWithinRoot.length === 0 || pathWithinRoot === '..' || pathWithinRoot.startsWith('../') || pathWithinRoot.startsWith('..\\')) {
      throw new Error('Refusing to operate on a worktree outside GhostD’s managed worktree root.');
    }
  }

  private async requireClean(cwd: string, label: string): Promise<void> {
    const status = await this.git(cwd, ['status', '--porcelain']);
    if (status.length !== 0) {
      throw new Error(`The ${label} has uncommitted changes; commit or stash them before continuing.`);
    }
  }

  private async requireCommit(cwd: string, commit: string): Promise<void> {
    await this.git(cwd, ['rev-parse', '--verify', `${commit}^{commit}`]);
  }

  private async requireAncestor(cwd: string, ancestor: string, descendant: string, message: string): Promise<void> {
    const result = await this.gitResult(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]);
    if (!result.ok) {
      throw new Error(message);
    }
  }

  private async git(cwd: string, args: string[]): Promise<string> {
    const result = await this.gitResult(cwd, args);
    if (!result.ok) {
      throw new Error(`Git ${args.at(0) ?? 'command'} failed.`);
    }
    return result.output.trimEnd();
  }

  private async gitResult(cwd: string, args: string[]): Promise<{ ok: boolean; output: string }> {
    try {
      const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
      return { ok: true, output: stdout };
    } catch {
      return { ok: false, output: '' };
    }
  }
}

function countLines(value: string): number {
  return value.length === 0 ? 0 : value.split('\n').filter((line) => line.length > 0).length;
}

function isGitRefName(value: string): boolean {
  return value.length > 0 && !value.startsWith('-') && !value.includes('..') && !/[\s~^:?*\\[\\]/.test(value) && !value.endsWith('.') && !value.endsWith('/');
}
