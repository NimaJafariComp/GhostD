import type { AgentCapabilities } from '../../core/materialization.js';
import type { ContextTargetAdapter } from '../targets.js';
import type { AnswerThinkingLevel } from '../../question/options.js';

const CLAUDE_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_API_VERSION = '2023-06-01';
const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MAX_TOKENS = 1024;

export interface ClaudeRequest {
  system: string;
  prompt: string;
  model?: string;
  thinking?: AnswerThinkingLevel;
}

export interface ClaudeResult {
  providerHandle: string;
  model: string;
  text: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface ClaudeTargetOptions {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
}

export class ClaudeApiError extends Error {
  public constructor(public readonly status: number) {
    super(`Claude Messages API request failed with status ${status}.`);
  }
}

export class ClaudeTargetAdapter implements ContextTargetAdapter {
  public readonly capabilities: AgentCapabilities = {
    provider: 'claude',
    supportsNativeFork: false,
    supportsSessionResume: false,
    cacheScope: 'request',
    cacheLifetime: 'ephemeral',
    contextWindowTokens: 1_000_000,
    workspaceAccess: 'none',
    toolAccess: 'none',
    writeAccess: false,
  };

  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly maxTokens: number;
  public readonly model: string;

  public constructor(options: ClaudeTargetOptions = {}) {
    this.apiKey = options.apiKey ?? process.env['ANTHROPIC_API_KEY'];
    this.model = options.model ?? process.env['GHOST_CLAUDE_MODEL'] ?? DEFAULT_CLAUDE_MODEL;
    this.maxTokens = options.maxTokens ?? configuredMaxTokens();
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public async ask(request: ClaudeRequest): Promise<ClaudeResult> {
    if (this.apiKey === undefined || this.apiKey.trim().length === 0) {
      throw new Error('ANTHROPIC_API_KEY is required to ask Claude.');
    }

    const response = await this.fetchImpl(CLAUDE_MESSAGES_URL, {
      method: 'POST',
      headers: {
        'anthropic-version': CLAUDE_API_VERSION,
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
      },
      body: JSON.stringify({
        model: request.model ?? this.model,
        max_tokens: this.maxTokens,
        system: request.system,
        messages: [{ role: 'user', content: request.prompt }],
        ...(request.thinking === undefined ? {} : {
          thinking: { type: 'adaptive', display: 'omitted' },
          output_config: { effort: claudeEffort(request.thinking) },
        }),
      }),
    });
    if (!response.ok) {
      throw new ClaudeApiError(response.status);
    }
    return parseClaudeResponse(await response.json(), request.model ?? this.model);
  }
}

function claudeEffort(thinking: AnswerThinkingLevel): 'low' | 'medium' | 'high' | 'xhigh' | 'max' {
  if (thinking === 'minimal') {
    return 'low';
  }
  return thinking;
}

function configuredMaxTokens(): number {
  const configured = process.env['GHOST_CLAUDE_MAX_TOKENS'];
  if (configured === undefined) {
    return DEFAULT_MAX_TOKENS;
  }
  const value = Number.parseInt(configured, 10);
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_MAX_TOKENS;
}

function parseClaudeResponse(value: unknown, fallbackModel: string): ClaudeResult {
  if (!isRecord(value)) {
    throw new Error('Claude Messages API returned an invalid response.');
  }
  const providerHandle = requiredString(value['id'], 'id');
  const content = value['content'];
  if (!Array.isArray(content)) {
    throw new Error('Claude Messages API response is missing content.');
  }
  const text = content
    .flatMap((block) => isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string' ? [block['text']] : [])
    .join('');
  if (text.length === 0) {
    throw new Error('Claude Messages API response did not include text content.');
  }
  const usage = isRecord(value['usage']) ? value['usage'] : {};
  const model = typeof value['model'] === 'string' && value['model'].trim().length > 0 ? value['model'] : fallbackModel;
  const inputTokens = numberField(usage['input_tokens']);
  const outputTokens = numberField(usage['output_tokens']);
  return {
    providerHandle,
    model,
    text,
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Claude Messages API response is missing ${field}.`);
  }
  return value;
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
