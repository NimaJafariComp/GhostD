import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentCapabilities } from '../../core/materialization.js';
import type { ContextTargetAdapter, TargetRequest, TargetResult } from '../targets.js';
import type { AnswerThinkingLevel } from '../../question/options.js';

const DEFAULT_CODEX_MODEL = 'codex-cli';

export interface CodexSidecarRequest {
  prompt: string;
  model?: string;
  thinking?: AnswerThinkingLevel;
}

export interface CodexSidecarRunner {
  run(request: CodexSidecarRequest): Promise<string>;
}

export class CodexSidecarError extends Error {
  public constructor(reason: 'not_found' | 'failed' | 'empty_response') {
    super(reason === 'not_found'
      ? 'Codex CLI is not available for a GhostD sidecar question.'
      : reason === 'empty_response'
        ? 'Codex sidecar completed without a final answer.'
        : 'Codex sidecar invocation failed.');
  }
}

/**
 * Stateless Codex target. It creates an ephemeral CLI invocation in an empty
 * temporary workspace, so it cannot attach to or modify the user's active chat.
 */
export class CodexTargetAdapter implements ContextTargetAdapter {
  public readonly capabilities: AgentCapabilities = {
    provider: 'codex',
    supportsNativeFork: false,
    supportsSessionResume: false,
    cacheScope: 'none',
    cacheLifetime: 'none',
    contextWindowTokens: 1_000_000,
    workspaceAccess: 'none',
    // Codex exposes read-only tool execution inside its empty temporary root.
    // No captured workspace is passed to that process and writes are sandbox-denied.
    toolAccess: 'read_only',
    writeAccess: false,
  };

  public readonly model: string;

  public constructor(
    private readonly runner: CodexSidecarRunner = new IsolatedCodexSidecarRunner(),
    model = process.env['GHOST_CODEX_MODEL'] ?? DEFAULT_CODEX_MODEL,
  ) {
    this.model = model;
  }

  public async ask(request: TargetRequest): Promise<TargetResult> {
    return {
      model: request.model ?? this.model,
      text: await this.runner.run({
        prompt: `${request.system}\n\n${request.prompt}`,
        ...((request.model ?? this.model) === DEFAULT_CODEX_MODEL ? {} : { model: request.model ?? this.model }),
        ...(request.thinking === undefined ? {} : { thinking: request.thinking }),
      }),
    };
  }
}

/** The fixed invocation deliberately permits neither session resume nor workspace writes. */
export function codexSidecarArguments(
  isolatedWorkspace: string,
  outputPath: string,
  model?: string,
  thinking?: AnswerThinkingLevel,
): string[] {
  return [
    '--sandbox', 'read-only',
    '--ask-for-approval', 'never',
    'exec',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--cd', isolatedWorkspace,
    '--output-last-message', outputPath,
    ...(model === undefined ? [] : ['--model', model]),
    ...(thinking === undefined ? [] : ['--config', `model_reasoning_effort=${JSON.stringify(thinking)}`]),
    '-',
  ];
}

class IsolatedCodexSidecarRunner implements CodexSidecarRunner {
  public async run(request: CodexSidecarRequest): Promise<string> {
    const isolatedWorkspace = await mkdtemp(join(tmpdir(), 'ghostd-codex-sidecar-'));
    const outputPath = join(isolatedWorkspace, 'answer.txt');
    try {
      await runCodex(codexSidecarArguments(isolatedWorkspace, outputPath, request.model, request.thinking), request.prompt, isolatedWorkspace);
      const answer = (await readFile(outputPath, 'utf8')).trim();
      if (answer.length === 0) {
        throw new CodexSidecarError('empty_response');
      }
      return answer;
    } finally {
      await rm(isolatedWorkspace, { force: true, recursive: true });
    }
  }
}

function runCodex(arguments_: readonly string[], prompt: string, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', arguments_, { cwd, stdio: ['pipe', 'ignore', 'ignore'] });
    let settled = false;
    const finish = (callback: () => void): void => {
      if (!settled) {
        settled = true;
        callback();
      }
    };
    child.once('error', (error: NodeJS.ErrnoException) => {
      finish(() => reject(new CodexSidecarError(error.code === 'ENOENT' ? 'not_found' : 'failed')));
    });
    child.once('close', (exitCode) => {
      finish(() => exitCode === 0 ? resolve() : reject(new CodexSidecarError('failed')));
    });
    child.stdin.end(prompt);
  });
}
