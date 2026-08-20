import { describe, expect, it } from 'vitest';

import { CodexTargetAdapter, codexSidecarArguments } from '../src/adapters/codex/target.js';
import type { CodexSidecarRequest, CodexSidecarRunner } from '../src/adapters/codex/target.js';

class FixtureRunner implements CodexSidecarRunner {
  public readonly requests: CodexSidecarRequest[] = [];

  public async run(request: CodexSidecarRequest): Promise<string> {
    this.requests.push(request);
    return 'Isolated Codex answer.';
  }
}

describe('Codex sidecar target', () => {
  it('uses a stateless, no-workspace target contract', async () => {
    const runner = new FixtureRunner();
    const target = new CodexTargetAdapter(runner, 'codex-test');

    await expect(target.ask({ system: 'Read only.', prompt: 'What is true?' })).resolves.toEqual({ model: 'codex-test', text: 'Isolated Codex answer.' });
    expect(target.capabilities).toMatchObject({
      provider: 'codex',
      supportsNativeFork: false,
      supportsSessionResume: false,
      workspaceAccess: 'none',
      toolAccess: 'read_only',
      writeAccess: false,
    });
    expect(runner.requests).toEqual([{ prompt: 'Read only.\n\nWhat is true?', model: 'codex-test' }]);
  });

  it('constructs a fixed ephemeral, read-only invocation in an isolated workspace', () => {
    const arguments_ = codexSidecarArguments('/private/tmp/ghostd-sidecar', '/private/tmp/ghostd-sidecar/answer.txt', 'codex-test');

    expect(arguments_).toEqual([
      '--sandbox', 'read-only', '--ask-for-approval', 'never', 'exec', '--ephemeral',
      '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--cd', '/private/tmp/ghostd-sidecar',
      '--output-last-message', '/private/tmp/ghostd-sidecar/answer.txt', '--model', 'codex-test', '-',
    ]);
    expect(arguments_).not.toContain('--add-dir');
    expect(arguments_).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('passes explicit model and reasoning effort only to the isolated sidecar', async () => {
    const runner = new FixtureRunner();
    const target = new CodexTargetAdapter(runner);
    await target.ask({ system: 'Read only.', prompt: 'What is true?', model: 'codex-mid', thinking: 'medium' });

    expect(runner.requests).toEqual([{ prompt: 'Read only.\n\nWhat is true?', model: 'codex-mid', thinking: 'medium' }]);
    expect(codexSidecarArguments('/tmp/ghost', '/tmp/ghost/answer.txt', 'codex-mid', 'medium')).toContain('model_reasoning_effort="medium"');
  });
});
