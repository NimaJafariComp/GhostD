import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { GhostEvent } from '../src/core/events.js';
import { GhostDatabase } from '../src/db/database.js';
import { GitWorktreeManager } from '../src/workspace/worktree.js';
import { WriteBranchService } from '../src/write/service.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function fixture(): Promise<{ database: GhostDatabase; directory: string; repository: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'ghostd-write-'));
  temporaryDirectories.push(directory);
  const repository = join(directory, 'repository');
  await mkdir(repository);
  git(repository, ['init', '-b', 'main']);
  git(repository, ['config', 'user.email', 'ghostd-test@example.invalid']);
  git(repository, ['config', 'user.name', 'GhostD Test']);
  await writeFile(join(repository, 'README.md'), 'base\n');
  git(repository, ['add', 'README.md']);
  git(repository, ['commit', '-m', 'base']);
  const head = git(repository, ['rev-parse', 'HEAD']);
  const database = await GhostDatabase.open(join(directory, 'ghost.db'));
  const event: GhostEvent = {
    schemaVersion: 1,
    id: 'event-1',
    sessionId: 'session-1',
    timestamp: '2026-08-19T12:00:00.000Z',
    source: 'codex',
    type: 'user_message',
    trustClass: 'user',
    payload: { text: 'Implement the isolated change.' },
    workspace: { cwd: repository, gitHead: head, gitStatus: '' },
  };
  database.append(event);
  const revision = database.createRevision(event.sessionId);
  database.createBranch('implementation', revision.id);
  return { database, directory, repository };
}

describe('Phase 5 write-capable branches', () => {
  it('allows only one worktree for a Ghost branch when agents create it concurrently', async () => {
    const { database, directory } = await fixture();
    try {
      const service = new WriteBranchService(database, new GitWorktreeManager(join(directory, 'managed-worktrees')));
      const results = await Promise.allSettled([service.create('implementation'), service.create('implementation')]);

      expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
      expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1);
      expect(database.writeWorktreeForBranch('implementation')).toMatchObject({ lifecycle: 'active' });
    } finally {
      database.close();
    }
  });

  it('isolates committed work, records provenance, explicitly fast-forwards, and preserves history after cleanup', async () => {
    const { database, directory, repository } = await fixture();
    try {
      const root = join(directory, 'managed-worktrees');
      const service = new WriteBranchService(database, new GitWorktreeManager(root), () => '2026-08-19T12:01:00.000Z');
      const worktree = await service.create('implementation');

      expect(worktree.repositoryPath).toBe(git(repository, ['rev-parse', '--show-toplevel']));
      expect(worktree.worktreePath).not.toBe(repository);
      expect(worktree.gitBranch).toMatch(/^ghostd\//);
      expect(git(repository, ['status', '--porcelain'])).toBe('');

      await writeFile(join(worktree.worktreePath, 'feature.txt'), 'isolated feature\n');
      git(worktree.worktreePath, ['add', 'feature.txt']);
      git(worktree.worktreePath, ['commit', '-m', 'add isolated feature']);

      const status = await service.status('implementation');
      expect(status).toMatchObject({ isClean: true, changedFileCount: 1, patches: [] });
      expect(await service.diff('implementation')).toContain('+isolated feature');
      await expect(service.promote('implementation', 'main', false)).rejects.toThrow('--approve');
      expect(() => git(repository, ['show', 'main:feature.txt'])).toThrow();

      const promotion = await service.promote('implementation', 'main', true);
      expect(promotion).toMatchObject({ status: 'succeeded', targetGitBranch: 'main' });
      expect(git(repository, ['show', 'main:feature.txt'])).toBe('isolated feature');
      expect(database.patchProvenanceForBranch('implementation')).toHaveLength(1);
      expect(database.writePromotionsForBranch('implementation')).toEqual([promotion]);

      const closed = await service.close('implementation');
      expect(closed.worktree.lifecycle).toBe('closed');
      await expect(access(worktree.worktreePath)).rejects.toThrow();
      expect(database.writeWorktreeForBranch('implementation')).toMatchObject({ lifecycle: 'closed' });
      expect(database.patchProvenanceForBranch('implementation')).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it('refuses dirty repositories and non-fast-forward promotion instead of resolving conflicts automatically', async () => {
    const { database, directory, repository } = await fixture();
    try {
      const root = join(directory, 'managed-worktrees');
      const service = new WriteBranchService(database, new GitWorktreeManager(root));
      await writeFile(join(repository, 'README.md'), 'dirty\n');
      await expect(service.create('implementation')).rejects.toThrow('uncommitted changes');
      await writeFile(join(repository, 'README.md'), 'base\n');

      const worktree = await service.create('implementation');
      await writeFile(join(worktree.worktreePath, 'feature.txt'), 'isolated feature\n');
      git(worktree.worktreePath, ['add', 'feature.txt']);
      git(worktree.worktreePath, ['commit', '-m', 'add isolated feature']);
      await writeFile(join(repository, 'target.txt'), 'target change\n');
      git(repository, ['add', 'target.txt']);
      git(repository, ['commit', '-m', 'advance target']);

      await expect(service.promote('implementation', 'main', true)).rejects.toThrow('would not fast-forward');
      expect(() => git(repository, ['show', 'main:feature.txt'])).toThrow();
    } finally {
      database.close();
    }
  });
});
