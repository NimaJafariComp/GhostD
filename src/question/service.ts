import { randomUUID } from 'node:crypto';

import { answerProviders } from '../ecosystem/config.js';
import type { AnswerProvider } from '../ecosystem/config.js';
import { GhostDatabase } from '../db/database.js';
import { MaterializationService } from '../materialization/service.js';
import type { AskClaudeResult } from '../materialization/service.js';
import { isAnswerThinkingLevel } from './options.js';
import type { AnswerSelection } from './options.js';

export interface QuestionInput extends AnswerSelection {
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
    throw new Error('Multiple open Ghost sessions are captured for this workspace. Run ghost session list, then ghost session use <number>.');
  }
  throw new Error('No active Ghost session is resolved for this workspace. Run ghost session list, then ghost session use <number>.');
}

/** Resolves the selected host's provider for the unqualified `ghost "…"` experience. */
export function resolveQuestionProvider(database: GhostDatabase, workspaceCwd: string): { sessionId: string; provider: AnswerProvider } {
  const sessionId = resolveQuestionSession(database, workspaceCwd);
  const session = database.session(sessionId);
  if (session === undefined) {
    throw new Error(`Resolved Ghost session ${sessionId} no longer exists.`);
  }
  if (!answerProviders.includes(session.source as AnswerProvider)) {
    throw new Error(`The selected ${session.source} session has no configured GhostD answer target. Use ghost codex, ghost claude, or ghost gemini explicitly.`);
  }
  return { sessionId, provider: session.source as AnswerProvider };
}

/**
 * Preference precedence is explicit choice, then a documented source-model
 * signal for the same provider, then the target provider's configured default.
 * Cross-provider sidecars always request medium thinking unless the user has
 * saved a different preference for that session/provider.
 */
export function resolveQuestionSelection(
  database: GhostDatabase,
  sessionId: string,
  provider: AnswerProvider,
): AnswerSelection {
  const session = database.session(sessionId);
  if (session === undefined) {
    throw new Error(`Ghost session ${sessionId} does not exist.`);
  }
  const preference = database.sessionAnswerPreference(sessionId, provider);
  const baseline: AnswerSelection = session.source === provider
    ? (() => {
      const model = database.capturedSourceModel(sessionId);
      return model === undefined ? {} : { model };
    })()
    : { thinking: 'medium' };
  const savedThinking = preference?.thinking !== undefined && isAnswerThinkingLevel(preference.thinking)
    ? preference.thinking
    : undefined;
  return {
    ...baseline,
    ...(preference?.model === undefined ? {} : { model: preference.model }),
    ...(savedThinking === undefined ? {} : { thinking: savedThinking }),
  };
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
      switch (input.provider) {
        case 'codex':
          return await this.materialization.askCodex({ branchName, prompt: input.prompt, mode: 'ephemeral', ...selection(input) });
        case 'claude':
          return await this.materialization.askClaude({ branchName, prompt: input.prompt, mode: 'ephemeral', ...selection(input) });
        case 'gemini':
          return await this.materialization.askGemini({ branchName, prompt: input.prompt, mode: 'ephemeral', ...selection(input) });
      }
    } finally {
      this.database.closeBranch(branchName);
    }
  }
}

function selection(input: QuestionInput): AnswerSelection {
  return {
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.thinking === undefined ? {} : { thinking: input.thinking }),
  };
}
