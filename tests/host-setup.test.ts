import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { hostCaptureStatus, installHostCapture, removeHostCapture } from '../src/adapters/host-setup.js';
import type { CapturableHost } from '../src/adapters/host-setup.js';

const temporaryDirectories: string[] = [];
const commands: Record<CapturableHost, string> = {
  codex: 'ghost codex-hook',
  claude: 'ghost claude-hook',
  gemini: 'ghost gemini-hook',
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe('universal host setup', () => {
  it('merges, detects, and removes only GhostD Claude project hooks', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ghostd-claude-setup-'));
    temporaryDirectories.push(workspace);
    const configDirectory = join(workspace, '.claude');
    const configPath = join(configDirectory, 'settings.local.json');
    await mkdir(configDirectory, { recursive: true });
    await writeFile(configPath, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'existing-hook' }] }], SessionEnd: [{ hooks: [{ type: 'http', url: 'https://example.invalid/audit' }] }] }, permissions: { allow: ['Read'] } }));

    await installHostCapture('claude', workspace, commands);
    await installHostCapture('claude', workspace, commands);

    expect(await hostCaptureStatus('claude', workspace, commands)).toMatchObject({ captureSupported: true, configured: true, configPath });
    const installed = JSON.parse(await readFile(configPath, 'utf8')) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>; permissions: { allow: string[] } };
    expect(installed.permissions).toEqual({ allow: ['Read'] });
    expect(installed.hooks.Stop?.[0]?.hooks.map(({ command }) => command)).toEqual(['existing-hook', 'ghost claude-hook']);
    expect(installed.hooks.SessionEnd?.[0]?.hooks).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'http', url: 'https://example.invalid/audit' }),
      expect.objectContaining({ type: 'command', command: 'ghost claude-hook' }),
    ]));
    expect(installed.hooks.UserPromptSubmit?.[0]?.hooks.map(({ command }) => command)).toEqual(['ghost claude-hook']);
    expect(installed.hooks.MessageDisplay?.[0]?.hooks.map(({ command }) => command)).toEqual(['ghost claude-hook']);

    await expect(removeHostCapture('claude', workspace, commands)).resolves.toBe(true);
    const removed = JSON.parse(await readFile(configPath, 'utf8')) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>; permissions: { allow: string[] } };
    expect(removed.permissions).toEqual({ allow: ['Read'] });
    expect(removed.hooks.Stop?.[0]?.hooks.map(({ command }) => command)).toEqual(['existing-hook']);
    await expect(removeHostCapture('claude', workspace, commands)).resolves.toBe(false);
  });

  it('writes only documented Gemini lifecycle hooks and preserves user configuration', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ghostd-gemini-setup-'));
    temporaryDirectories.push(workspace);
    const configDirectory = join(workspace, '.gemini');
    const configPath = join(configDirectory, 'settings.json');
    await mkdir(configDirectory, { recursive: true });
    await writeFile(configPath, JSON.stringify({ model: 'gemini-3.6-flash', hooks: { BeforeTool: [{ matcher: 'read_.*', hooks: [{ type: 'command', command: 'existing-hook' }] }] } }));

    await installHostCapture('gemini', workspace, commands);

    expect(await hostCaptureStatus('gemini', workspace, commands)).toMatchObject({ captureSupported: true, configured: true, configPath });
    const installed = JSON.parse(await readFile(configPath, 'utf8')) as { model: string; hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>> };
    expect(installed.model).toBe('gemini-3.6-flash');
    expect(installed.hooks.BeforeTool).toEqual(expect.arrayContaining([
      expect.objectContaining({ matcher: 'read_.*', hooks: [{ type: 'command', command: 'existing-hook' }] }),
      expect.objectContaining({ hooks: [{ type: 'command', command: 'ghost gemini-hook' }] }),
    ]));
    expect(installed.hooks.AfterAgent?.[0]?.hooks.map(({ command }) => command)).toEqual(['ghost gemini-hook']);
    expect(installed.hooks.PreCompress?.[0]?.hooks.map(({ command }) => command)).toEqual(['ghost gemini-hook']);
  });

  it('reports unsupported hosts as unavailable without creating configuration', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ghostd-unsupported-setup-'));
    temporaryDirectories.push(workspace);

    await expect(hostCaptureStatus('antigravity', workspace, commands)).resolves.toEqual({
      host: 'antigravity',
      captureSupported: false,
      configured: false,
      reason: 'No verified Antigravity source-capture contract is available.',
    });
  });
});
