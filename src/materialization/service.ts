import { ClaudeApiError, ClaudeTargetAdapter } from '../adapters/claude/target.js';
import { CodexTargetAdapter } from '../adapters/codex/target.js';
import { GeminiApiError, GeminiTargetAdapter } from '../adapters/gemini/target.js';
import { chooseMaterializationStrategy } from '../adapters/targets.js';
import type { ContextTargetAdapter } from '../adapters/targets.js';
import { compileContext, renderContext } from '../context/compiler.js';
import type { GhostBranch, GhostRevision, WorkspaceSnapshot } from '../core/graph.js';
import type { MaterializationMode, MaterializationRun } from '../core/materialization.js';
import { GhostDatabase } from '../db/database.js';
import { redactText } from '../privacy/redaction.js';
import type { AnswerSelection } from '../question/options.js';

export interface AskClaudeInput extends AnswerSelection {
  branchName: string;
  prompt: string;
  mode: MaterializationMode;
}

export interface AskClaudeResult {
  text: string;
  revision: GhostRevision;
  snapshot: WorkspaceSnapshot;
  run: MaterializationRun;
}

export class MaterializationFailureError extends Error {
  public constructor(public readonly run: MaterializationRun) {
    super(`${providerLabel(run.provider)} materialization failed (${run.failureCode ?? 'provider_error'}). ${run.recovery}`);
  }
}

export class MaterializationService {
  public constructor(
    private readonly database: GhostDatabase,
    private readonly claude: ContextTargetAdapter = new ClaudeTargetAdapter(),
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly clock: () => number = () => Date.now(),
    private readonly gemini: ContextTargetAdapter = new GeminiTargetAdapter(),
    private readonly codex: ContextTargetAdapter = new CodexTargetAdapter(),
  ) {}

  public async askClaude(input: AskClaudeInput): Promise<AskClaudeResult> {
    return this.askTarget(input, this.claude);
  }

  public async askGemini(input: AskClaudeInput): Promise<AskClaudeResult> {
    return this.askTarget(input, this.gemini);
  }

  public async askCodex(input: AskClaudeInput): Promise<AskClaudeResult> {
    return this.askTarget(input, this.codex);
  }

  private async askTarget(input: AskClaudeInput, target: ContextTargetAdapter): Promise<AskClaudeResult> {
    if (input.prompt.trim().length === 0) {
      throw new Error('An ask prompt is required.');
    }
    const branch = requiredBranch(this.database, input.branchName);
    const revision = requiredRevision(this.database, branch.headRevisionId);
    const snapshot = requiredSnapshot(this.database, revision.workspaceSnapshotId);
    const context = renderContext(
      compileContext(this.database.eventsForSessionThrough(revision.sessionId, revision.eventHighWaterMark)),
      true,
    );
    const strategy = chooseMaterializationStrategy(target.capabilities);
    const startedAt = this.now();
    const run = this.database.startMaterializationRun({
      branchId: branch.id,
      provider: target.capabilities.provider,
      model: input.model ?? target.model,
      ...(input.thinking === undefined ? {} : { thinking: input.thinking }),
      sourceRevisionId: revision.id,
      mode: input.mode,
      strategy,
      createdAt: startedAt,
    });

    const startedAtMs = this.clock();
    try {
      const remoteContext = redactText(context, 'remote').value;
      const remotePrompt = redactText(input.prompt, 'remote').value;
      const result = await target.ask({
        system: systemPrompt(target.capabilities.provider, revision, snapshot),
        prompt: `${remoteContext}\n\nUSER ASK\n${remotePrompt}`,
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.thinking === undefined ? {} : { thinking: input.thinking }),
      });
      const latencyMs = Math.max(0, this.clock() - startedAtMs);
      const materialization = this.database.recordMaterialization(
        branch.name,
        target.capabilities.provider,
        revision.id,
        result.providerHandle,
        this.now(),
      );
      const cost = estimatedCost(result.inputTokens, result.outputTokens);
      const completed = this.database.completeMaterializationRun(run.id, {
        materializationId: materialization.id,
        model: result.model,
        ...(result.providerHandle === undefined ? {} : { providerHandle: result.providerHandle }),
        ...(result.inputTokens === undefined ? {} : { inputTokens: result.inputTokens }),
        ...(result.outputTokens === undefined ? {} : { outputTokens: result.outputTokens }),
        ...(cost === undefined ? {} : { estimatedCostUsd: cost }),
        latencyMs,
        responseText: redactText(result.text, 'storage').value,
        completedAt: this.now(),
      });
      return { text: result.text, revision, snapshot, run: completed };
    } catch (error: unknown) {
      const failed = this.database.failMaterializationRun(
        run.id,
        failureCode(error),
        this.now(),
        Math.max(0, this.clock() - startedAtMs),
      );
      throw new MaterializationFailureError(failed);
    }
  }
}

function systemPrompt(provider: string, revision: GhostRevision, snapshot: WorkspaceSnapshot): string {
  return [
    `You are GhostD's read-only ${provider} target.`,
    'Answer only from the supplied Ghost context and the user ask. Do not assume hidden provider state.',
    'Do not use tools or workspace access. You have no authority to modify files, Git state, or Ghost history.',
    `Ghost revision: ${revision.id}`,
    `Workspace snapshot: ${snapshot.id}`,
  ].join('\n');
}

function requiredBranch(database: GhostDatabase, name: string): GhostBranch {
  const branch = database.branch(name);
  if (branch === undefined) {
    throw new Error(`Branch ${name} does not exist.`);
  }
  return branch;
}

function requiredRevision(database: GhostDatabase, id: string): GhostRevision {
  const revision = database.revision(id);
  if (revision === undefined) {
    throw new Error(`Revision ${id} does not exist.`);
  }
  return revision;
}

function requiredSnapshot(database: GhostDatabase, id: string): WorkspaceSnapshot {
  const snapshot = database.workspaceSnapshot(id);
  if (snapshot === undefined) {
    throw new Error(`Workspace snapshot ${id} does not exist.`);
  }
  return snapshot;
}

function failureCode(error: unknown): string {
  if (error instanceof ClaudeApiError || error instanceof GeminiApiError) {
    return `http_${error.status}`;
  }
  if (error instanceof Error && /API_KEY/.test(error.message)) {
    return 'missing_api_key';
  }
  return 'provider_error';
}

function estimatedCost(inputTokens: number | undefined, outputTokens: number | undefined): number | undefined {
  const inputPrice = configuredPrice('GHOST_CLAUDE_INPUT_USD_PER_MILLION_TOKENS');
  const outputPrice = configuredPrice('GHOST_CLAUDE_OUTPUT_USD_PER_MILLION_TOKENS');
  if (inputTokens === undefined || outputTokens === undefined || inputPrice === undefined || outputPrice === undefined) {
    return undefined;
  }
  return (inputTokens * inputPrice + outputTokens * outputPrice) / 1_000_000;
}

function configuredPrice(name: string): number | undefined {
  const value = process.env[name];
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function providerLabel(provider: string): string {
  return provider.length === 0 ? 'Provider' : `${provider.charAt(0).toUpperCase()}${provider.slice(1)}`;
}
