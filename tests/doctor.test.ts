import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { inspectDoctorStorage, renderDoctorReport } from '../src/distribution/doctor.js';

const directories: string[] = [];

afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true }))));

describe('GhostD doctor', () => {
  it('inspects a missing database without creating storage', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ghostd-doctor-'));
    directories.push(directory);
    const databasePath = join(directory, 'ghost', 'ghost.db');

    await expect(inspectDoctorStorage(databasePath)).resolves.toMatchObject({ database: 'absent', directory: 'absent', databasePath });
  });

  it('reports private and unsafe storage permissions accurately', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ghostd-doctor-'));
    directories.push(directory);
    const databasePath = join(directory, 'ghost.db');
    await writeFile(databasePath, 'fixture', { mode: 0o600 });
    await chmod(directory, 0o700);

    await expect(inspectDoctorStorage(databasePath)).resolves.toMatchObject({ database: 'private', directory: 'private' });
    await chmod(databasePath, 0o644);
    await expect(inspectDoctorStorage(databasePath)).resolves.toMatchObject({ database: 'accessible-by-group-or-others' });
  });

  it('renders actionable read-only recovery diagnostics without credentials', () => {
    const rendered = renderDoctorReport({
      nodeVersion: 'v24.0.0',
      platform: 'darwin',
      architecture: 'arm64',
      workspace: '/work/ghostd',
      storage: { databasePath: '/home/user/.ghost/ghost.db', database: 'absent', directory: 'absent' },
      providers: [
        { provider: 'codex', displayName: 'Codex', executable: 'codex', installed: true, version: 'codex 1.0.0' },
        { provider: 'claude', displayName: 'Claude Code', executable: 'claude', packageName: '@anthropic-ai/claude-code', installed: false },
      ],
      captures: [
        { host: 'codex', captureSupported: true, configured: true, configPath: '/work/ghostd/.codex/hooks.json' },
        { host: 'claude', captureSupported: true, configured: false, configPath: '/work/ghostd/.claude/settings.local.json' },
      ],
      configuration: { version: 1, providers: {}, defaultAnswerProvider: 'codex' },
    });

    expect(rendered).toContain('GhostD doctor (read-only)');
    expect(rendered).toContain('install with ghost providers install claude');
    expect(rendered).toContain('Codex project trust: user confirmation required');
    expect(rendered).toContain('No changes were made.');
    expect(rendered).not.toMatch(/api[_ -]?key|token|secret/i);
  });
});
