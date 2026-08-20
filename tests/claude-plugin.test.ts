import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { claudeCaptureEvents } from '../src/adapters/host-setup.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = join(repositoryRoot, 'integrations', 'claude', 'ghostd');
const wrapperPath = join(pluginRoot, 'bin', 'ghostd-claude-hook.cjs');
const temporaryDirectories: string[] = [];

interface PluginManifest {
  name: string;
  displayName: string;
  version: string;
}

interface HookConfiguration {
  hooks: Record<string, Array<{
    hooks: Array<{ type: string; command: string; args: string[] }>;
  }>>;
}

function run(command: string, arguments_: string[], input: string, environment: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, arguments_, { env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => resolveRun({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function writeGhostFixture(binDirectory: string, source: string): Promise<void> {
  const fixturePath = join(binDirectory, 'ghost.cjs');
  await writeFile(fixturePath, source);
  if (process.platform === 'win32') {
    await writeFile(join(binDirectory, 'ghost.cmd'), `@echo off\r\n\"${process.execPath}\" \"%~dp0ghost.cjs\" %*\r\n`);
    return;
  }
  const ghostPath = join(binDirectory, 'ghost');
  await writeFile(ghostPath, `#!${process.execPath}\nrequire('./ghost.cjs');\n`);
  await chmod(ghostPath, 0o755);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe('GhostD Claude Code plugin', () => {
  it('packages the exact documented capture event set in a versioned native plugin', async () => {
    const manifest = JSON.parse(await readFile(join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8')) as PluginManifest;
    const hooks = JSON.parse(await readFile(join(pluginRoot, 'hooks', 'hooks.json'), 'utf8')) as HookConfiguration;
    const marketplace = JSON.parse(await readFile(join(repositoryRoot, '.claude-plugin', 'marketplace.json'), 'utf8')) as {
      name: string;
      plugins: Array<{ name: string; source: string; version: string }>;
    };

    expect(manifest).toMatchObject({ name: 'ghostd', displayName: 'GhostD', version: '0.1.1' });
    expect(manifest).not.toHaveProperty('hooks');
    expect(Object.keys(hooks.hooks)).toEqual([...claudeCaptureEvents]);
    for (const event of claudeCaptureEvents) {
      expect(hooks.hooks[event]).toEqual([{
        hooks: [{ type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/bin/ghostd-claude-hook.cjs'] }],
      }]);
    }
    expect(marketplace).toMatchObject({
      name: 'ghostd',
      plugins: [{ name: 'ghostd', source: './integrations/claude/ghostd', version: manifest.version }],
    });
  });

  it('forwards documented hook stdin unchanged to GhostD without transcript access', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ghostd-claude-plugin-'));
    temporaryDirectories.push(directory);
    const binDirectory = join(directory, 'bin');
    const inputPath = join(directory, 'hook-input.json');
    const argumentsPath = join(directory, 'hook-arguments.txt');
    await mkdir(binDirectory, { recursive: true });
    await writeGhostFixture(binDirectory, [
      "const { writeFileSync } = require('node:fs');",
      "writeFileSync(process.env.GHOSTD_TEST_INPUT_PATH, require('node:fs').readFileSync(0));",
      "writeFileSync(process.env.GHOSTD_TEST_ARGUMENTS_PATH, process.argv.slice(2).join(' '));",
    ].join('\n'));

    const rawHook = JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'plugin-session',
      cwd: '/work/plugin',
      prompt: 'Do not read transcript files.',
      transcript_path: '/provider/private/transcript.jsonl',
    });
    const result = await run(process.execPath, [wrapperPath], rawHook, {
      ...process.env,
      PATH: `${binDirectory}${delimiter}${process.env['PATH'] ?? ''}`,
      GHOSTD_TEST_INPUT_PATH: inputPath,
      GHOSTD_TEST_ARGUMENTS_PATH: argumentsPath,
    });

    expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
    await expect(readFile(inputPath, 'utf8')).resolves.toBe(rawHook);
    await expect(readFile(argumentsPath, 'utf8')).resolves.toBe('claude-hook');
  });

  it('is observational when GhostD is temporarily unavailable', async () => {
    const result = await run(process.execPath, [wrapperPath], '{"hook_event_name":"SessionStart"}', {
      ...process.env,
      PATH: '/usr/bin:/bin',
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('GhostD capture skipped');
  });
});
