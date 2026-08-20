import { randomUUID } from 'node:crypto';

import type { AnswerProvider } from '../ecosystem/config.js';
import { GhostDatabase } from '../db/database.js';
import { MaterializationService } from '../materialization/service.js';
import type { AskClaudeResult } from '../materialization/service.js';

export interface QuestionInput {
  sessionId: string;
  provider: AnswerProvider;
  prompt: string;
}

/**
 * Resolves only a user selection or a single open captured session in this workspace.
 * It deliberately never infers an active conversation from recency, focus, or provider state.
 */
export function resolveQuestionSession(database: GhostDatabase, workspaceCwd: string): string {
  const resolved = database.resolvedSession(workspaceCwd);
  if (resolved !== undefined) {
    return resolved.id;
  }
  const openSessionCount = database.sessions(workspaceCwd).filter(({ endedAt }) => endedAt === undefined).length;
  if (openSessionCount > 1) {
    throw new Error('Multiple open Ghost sessions are captured for this workspace. Run ghost session list, then ghost session use <id>.');
  }
  throw new Error('No active Ghost session is resolved for this workspace. Run ghost session list, then ghost session use <id>.');
}

/**
 * A terminal sidecar question has no provider session and no user-managed branch.
 * The short-lived closed branch is an internal immutable-ledger anchor for its materialization run.
 */
export class QuestionService {
  public constructor(
    private readonly database: GhostDatabase,
    private readonly materialization: MaterializationService = new MaterializationService(database),
    private readonly nextId: () => string = randomUUID,
  ) {}

  public async ask(input: QuestionInput): Promise<AskClaudeResult> {
    if (input.prompt.trim().length === 0) {
      throw new Error('A question prompt is required.');
    }
    const revision = this.database.createRevision(input.sessionId);
    const branchName = `question-${this.nextId()}`;
    this.database.createBranch(branchName, revision.id, 'ephemeral');
    try {
      return input.provider === 'claude'
        ? await this.materialization.askClaude({ branchName, prompt: input.prompt, mode: 'ephemeral' })
        : await this.materialization.askGemini({ branchName, prompt: input.prompt, mode: 'ephemeral' });
    } finally {
      this.database.closeBranch(branchName);
    }
  }
}
