import { execFileSync } from 'node:child_process';

import type { WorkspaceState } from '../core/events.js';

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trimEnd();
  } catch {
    return undefined;
  }
}

/** Captures only Git metadata; it never reads a Codex transcript. */
export function snapshotWorkspace(cwd: string): WorkspaceState {
  const gitHead = git(cwd, ['rev-parse', 'HEAD']);
  const gitStatus = git(cwd, ['status', '--porcelain']);
  return {
    cwd,
    ...(gitHead === undefined || gitHead.length === 0 ? {} : { gitHead }),
    ...(gitStatus === undefined ? {} : { gitStatus }),
  };
}
