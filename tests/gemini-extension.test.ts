import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { geminiCaptureEvents } from '../src/adapters/host-setup.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extensionRoot = join(repositoryRoot, 'integrations', 'gemini', 'ghostd');
const launcherPath = join(extensionRoot, 'bin', 'ghostd-gemini-hook.cjs');
const temporaryDirectories: string[] = [];

interface ExtensionManifest {
  name: string;
  version: string;
  description: string;
}

interface HookConfiguration {
  hooks: Record<string, Array<{
    hooks: Array<{ name: string; type: string; command: string; timeout: number }>;
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

describe('GhostD Gemini CLI extension', () => {
  it('packages the exact documented capture event set with an observational hook command', async () => {
    const manifest = JSON.parse(await readFile(join(extensionRoot, 'gemini-extension.json'), 'utf8')) as ExtensionManifest;
    const hooks = JSON.parse(await readFile(join(extensionRoot, 'hooks', 'hooks.json'), 'utf8')) as HookConfiguration;

    expect(manifest).toMatchObject({ name: 'ghostd', version: '0.1.1' });
    expect(Object.keys(hooks.hooks)).toEqual([...geminiCaptureEvents]);
    for (const event of geminiCaptureEvents) {
      const handler = hooks.hooks[event]?.[0]?.hooks[0];
      expect(handler).toMatchObject({
        name: `ghostd-capture-${event.replaceAll(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()}`,
        type: 'command',
        command: 'node "${extensionPath}${/}bin${/}ghostd-gemini-hook.cjs"',
        timeout: 10_000,
      });
    }
  });

  it('forwards hook stdin to GhostD while emitting only valid Gemini hook JSON', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ghostd-gemini-extension-'));
    temporaryDirectories.push(directory);
    const binDirectory = join(directory, 'bin');
    const inputPath = join(directory, 'hook-input.json');
    const argumentsPath = join(directory, 'hook-arguments.txt');
    await mkdir(binDirectory, { recursive: true });
    await writeGhostFixture(binDirectory, [
      "const { readFileSync, writeFileSync } = require('node:fs');",
      "writeFileSync(process.env.GHOSTD_TEST_INPUT_PATH, readFileSync(0));",
      "writeFileSync(process.env.GHOSTD_TEST_ARGUMENTS_PATH, process.argv.slice(2).join(' '));",
      "process.stdout.write('unexpected child stdout');",
    ].join('\n'));

    const rawHook = JSON.stringify({
      hook_event_name: 'BeforeAgent',
      session_id: 'gemini-plugin-session',
      cwd: '/work/plugin',
      prompt: 'Do not read transcript files.',
      transcript_path: '/provider/private/transcript.json',
    });
    const result = await run(process.execPath, [launcherPath], rawHook, {
      ...process.env,
      PATH: `${binDirectory}${delimiter}${process.env['PATH'] ?? ''}`,
      GHOSTD_TEST_INPUT_PATH: inputPath,
      GHOSTD_TEST_ARGUMENTS_PATH: argumentsPath,
    });

    expect(result).toEqual({ code: 0, stdout: '{}\n', stderr: '' });
    await expect(readFile(inputPath, 'utf8')).resolves.toBe(rawHook);
    await expect(readFile(argumentsPath, 'utf8')).resolves.toBe('gemini-hook');
  });

  it('preserves Gemini control flow when GhostD is unavailable', async () => {
    const result = await run(process.execPath, [launcherPath], '{"hook_event_name":"SessionStart"}', {
      ...process.env,
      PATH: '/usr/bin:/bin',
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('{}\n');
    expect(result.stderr).toContain('GhostD capture skipped');
  });

  it('preserves Gemini control flow when GhostD rejects a hook event', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ghostd-gemini-extension-failure-'));
    temporaryDirectories.push(directory);
    const binDirectory = join(directory, 'bin');
    await mkdir(binDirectory, { recursive: true });
    await writeGhostFixture(binDirectory, "process.stderr.write('invalid hook payload\\n'); process.exit(1);");

    const result = await run(process.execPath, [launcherPath], '{"hook_event_name":"SessionStart"}', {
      ...process.env,
      PATH: `${binDirectory}${delimiter}${process.env['PATH'] ?? ''}`,
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('{}\n');
    expect(result.stderr).toContain('invalid hook payload');
    expect(result.stderr).toContain('GhostD capture skipped: the ghost command could not process this Gemini hook event.');
  });
});
