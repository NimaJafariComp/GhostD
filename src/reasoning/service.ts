import { ClaudeApiError, ClaudeTargetAdapter } from '../adapters/claude/target.js';
import { GeminiApiError, GeminiTargetAdapter } from '../adapters/gemini/target.js';
import type { ContextTargetAdapter } from '../adapters/targets.js';
import { compileContext, renderContext } from '../context/compiler.js';
import type { ComparisonInsight, ComparisonParticipant, ComparisonRun, InsightPayload } from '../core/reasoning.js';
import { GhostDatabase } from '../db/database.js';
import { redactText } from '../privacy/redaction.js';

export interface CompareInput {
  branchName: string;
  prompt: string;
}

export interface CompareResult {
  run: ComparisonRun;
  participants: ComparisonParticipant[];
  insights: ComparisonInsight[];
}

/** Runs providers independently against the exact same immutable Ghost revision. */
export class ComparisonService {
  public constructor(
    private readonly database: GhostDatabase,
    private readonly targets: readonly ContextTargetAdapter[] = [new ClaudeTargetAdapter(), new GeminiTargetAdapter()],
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly clock: () => number = () => Date.now(),
  ) {}

  public async compare(input: CompareInput): Promise<CompareResult> {
    if (input.prompt.trim().length === 0) {
      throw new Error('A comparison prompt is required.');
    }
    if (this.targets.length < 2) {
      throw new Error('A comparison requires at least two configured targets.');
    }
    const run = this.database.createComparisonRun(input.branchName, input.prompt, this.now());
    const revision = this.database.revision(run.frozenRevisionId);
    const snapshot = this.database.workspaceSnapshot(run.workspaceSnapshotId);
    if (revision === undefined || snapshot === undefined) {
      throw new Error(`Comparison run ${run.id} references missing frozen context.`);
    }
    const events = this.database.eventsForSessionThrough(revision.sessionId, revision.eventHighWaterMark);
    const context = redactText(renderContext(compileContext(events), true), 'remote').value;
    const prompt = redactText(input.prompt, 'remote').value;
    const eventIds = new Set(events.map(({ id }) => id));
    const system = comparisonSystemPrompt(revision.id, snapshot.id, [...eventIds]);

    await Promise.all(this.targets.map(async (target) => {
      await this.compareTarget(run.id, target, system, context, prompt, eventIds);
    }));
    const completed = this.database.finalizeComparisonRun(run.id, this.now());
    return {
      run: completed,
      participants: this.database.comparisonParticipants(completed.id),
      insights: this.database.comparisonInsights(completed.id),
    };
  }

  private async compareTarget(
    comparisonRunId: string,
    target: ContextTargetAdapter,
    system: string,
    context: string,
    prompt: string,
    eventIds: ReadonlySet<string>,
  ): Promise<void> {
    const participant = this.database.startComparisonParticipant(
      comparisonRunId,
      target.capabilities.provider,
      target.model,
      this.now(),
    );
    const startedAt = this.clock();
    try {
      const response = await target.ask({
        system,
        prompt: `${context}\n\nCOMPARISON ASK\n${prompt}`,
        responseFormat: 'json',
      });
      const completed = this.database.completeComparisonParticipant(participant.id, {
        ...(response.providerHandle === undefined ? {} : { providerHandle: response.providerHandle }),
        responseText: response.text,
        ...(response.inputTokens === undefined ? {} : { inputTokens: response.inputTokens }),
        ...(response.outputTokens === undefined ? {} : { outputTokens: response.outputTokens }),
        latencyMs: Math.max(0, this.clock() - startedAt),
        completedAt: this.now(),
      });
      const insights = parseInsights(response.text, eventIds);
      if (insights !== undefined) {
        this.database.recordComparisonInsights(completed.id, insights, this.now());
      }
    } catch (error: unknown) {
      this.database.failComparisonParticipant(
        participant.id,
        failureCode(error),
        this.now(),
        Math.max(0, this.clock() - startedAt),
      );
    }
  }
}

function comparisonSystemPrompt(revisionId: string, snapshotId: string, eventIds: string[]): string {
  return [
    'You are a GhostD read-only comparison participant.',
    'Use only the supplied Ghost context. Do not assume hidden provider state, use tools, access a workspace, or modify anything.',
    `Frozen Ghost revision: ${revisionId}`,
    `Frozen workspace snapshot: ${snapshotId}`,
    `Evidence may cite only these canonical event IDs: ${eventIds.join(', ')}`,
    'Return only JSON with this exact shape:',
    '{"findings":["..."],"evidence":[{"text":"...","eventIds":["event-id"]}],"recommendations":["..."]}',
    'Every evidence eventIds entry must be non-empty. If the context does not support a claim, omit it.',
  ].join('\n');
}

function parseInsights(text: string, allowedEventIds: ReadonlySet<string>): InsightPayload | undefined {
  const parsed = parseJsonObject(text);
  if (parsed === undefined) {
    return undefined;
  }
  const findings = stringArray(parsed['findings']);
  const recommendations = stringArray(parsed['recommendations']);
  const evidence = evidenceArray(parsed['evidence'], allowedEventIds);
  if (findings === undefined || recommendations === undefined || evidence === undefined) {
    return undefined;
  }
  return { findings, evidence, recommendations };
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  const candidate = trimmed.startsWith('```json') && trimmed.endsWith('```')
    ? trimmed.slice(7, -3).trim()
    : trimmed;
  try {
    const value = JSON.parse(candidate) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.trim().length > 0)) {
    return undefined;
  }
  return value.map((item) => item.trim());
}

function evidenceArray(value: unknown, allowedEventIds: ReadonlySet<string>): Array<{ text: string; eventIds: string[] }> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const evidence: Array<{ text: string; eventIds: string[] }> = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return undefined;
    }
    const record = item as Record<string, unknown>;
    const text = record['text'];
    const eventIds = stringArray(record['eventIds']);
    if (typeof text !== 'string' || text.trim().length === 0 || eventIds === undefined || eventIds.length === 0 || eventIds.some((id) => !allowedEventIds.has(id))) {
      return undefined;
    }
    evidence.push({ text: text.trim(), eventIds });
  }
  return evidence;
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
