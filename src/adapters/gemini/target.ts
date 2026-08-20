import type { AgentCapabilities } from '../../core/materialization.js';
import type { ContextTargetAdapter, TargetRequest, TargetResult } from '../targets.js';

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
// Google keeps older models listable after they stop accepting new users.
// Use the model Google currently directs new Gemini API projects to.
const DEFAULT_GEMINI_MODEL = 'gemini-3.6-flash';
const DEFAULT_MAX_TOKENS = 1024;
const geminiThinkingLevels = ['minimal', 'low', 'medium', 'high'] as const;
const DEFAULT_GEMINI_THINKING_LEVEL = 'minimal';

type GeminiThinkingLevel = (typeof geminiThinkingLevels)[number];

export interface GeminiTargetOptions {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  thinkingLevel?: GeminiThinkingLevel;
  fetchImpl?: typeof fetch;
}

export class GeminiApiError extends Error {
  public constructor(public readonly status: number) {
    super(`Gemini generateContent request failed with status ${status}.`);
  }
}

/** Stateless Gemini target. It never sends tools, workspace access, or hidden provider state. */
export class GeminiTargetAdapter implements ContextTargetAdapter {
  public readonly capabilities: AgentCapabilities = {
    provider: 'gemini',
    supportsNativeFork: false,
    supportsSessionResume: false,
    cacheScope: 'none',
    cacheLifetime: 'none',
    contextWindowTokens: 1_000_000,
    workspaceAccess: 'none',
    toolAccess: 'none',
    writeAccess: false,
  };

  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly maxTokens: number;
  private readonly thinkingLevel: GeminiThinkingLevel;
  public readonly model: string;

  public constructor(options: GeminiTargetOptions = {}) {
    this.apiKey = options.apiKey ?? process.env['GEMINI_API_KEY'] ?? process.env['GOOGLE_API_KEY'];
    this.model = options.model ?? process.env['GHOST_GEMINI_MODEL'] ?? DEFAULT_GEMINI_MODEL;
    this.maxTokens = options.maxTokens ?? configuredMaxTokens();
    this.thinkingLevel = options.thinkingLevel ?? configuredThinkingLevel();
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public async ask(request: TargetRequest): Promise<TargetResult> {
    if (this.apiKey === undefined || this.apiKey.trim().length === 0) {
      throw new Error('GEMINI_API_KEY or GOOGLE_API_KEY is required to ask Gemini.');
    }
    const response = await this.fetchImpl(`${GEMINI_API_URL}/${encodeURIComponent(this.model)}:generateContent`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': this.apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: request.system }] },
        contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
        generationConfig: {
          maxOutputTokens: this.maxTokens,
          thinkingConfig: { thinkingLevel: this.thinkingLevel },
          ...(request.responseFormat === 'json' ? { responseMimeType: 'application/json' } : {}),
        },
      }),
    });
    if (!response.ok) {
      throw new GeminiApiError(response.status);
    }
    return parseGeminiResponse(await response.json(), this.model);
  }
}

function configuredMaxTokens(): number {
  const configured = process.env['GHOST_GEMINI_MAX_TOKENS'];
  if (configured === undefined) {
    return DEFAULT_MAX_TOKENS;
  }
  const value = Number.parseInt(configured, 10);
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_MAX_TOKENS;
}

function configuredThinkingLevel(): GeminiThinkingLevel {
  const configured = process.env['GHOST_GEMINI_THINKING_LEVEL'];
  return configured !== undefined && isGeminiThinkingLevel(configured)
    ? configured
    : DEFAULT_GEMINI_THINKING_LEVEL;
}

function isGeminiThinkingLevel(value: string): value is GeminiThinkingLevel {
  return geminiThinkingLevels.some((level) => level === value);
}

function parseGeminiResponse(value: unknown, fallbackModel: string): TargetResult {
  if (!isRecord(value)) {
    throw new Error('Gemini generateContent returned an invalid response.');
  }
  const candidates = value['candidates'];
  if (!Array.isArray(candidates)) {
    throw new Error('Gemini generateContent response is missing candidates.');
  }
  const text = candidates
    .flatMap((candidate) => isRecord(candidate) && isRecord(candidate['content']) && Array.isArray(candidate['content']['parts'])
      ? candidate['content']['parts']
        .flatMap((part) => isRecord(part) && typeof part['text'] === 'string' ? [part['text']] : [])
      : [])
    .join('');
  if (text.length === 0) {
    throw new Error('Gemini generateContent response did not include text content.');
  }
  const usage = isRecord(value['usageMetadata']) ? value['usageMetadata'] : {};
  const model = nonEmptyString(value['modelVersion']) ?? fallbackModel;
  const providerHandle = nonEmptyString(value['responseId']);
  const inputTokens = numberField(usage['promptTokenCount']);
  const outputTokens = numberField(usage['candidatesTokenCount']);
  return {
    ...(providerHandle === undefined ? {} : { providerHandle }),
    model,
    text,
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
