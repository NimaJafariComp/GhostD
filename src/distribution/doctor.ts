import { stat } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { HostCaptureStatus } from '../adapters/host-setup.js';
import type { ProviderCliStatus } from '../adapters/provider-cli.js';
import type { GhostConfiguration } from '../ecosystem/config.js';

export type PrivatePathState = 'absent' | 'private' | 'accessible-by-group-or-others';

export interface DoctorStorageStatus {
  database: PrivatePathState;
  directory: PrivatePathState;
  databasePath: string;
}

export interface DoctorReport {
  nodeVersion: string;
  platform: string;
  architecture: string;
  workspace: string;
  storage: DoctorStorageStatus;
  providers: readonly ProviderCliStatus[];
  captures: readonly HostCaptureStatus[];
  configuration: GhostConfiguration;
}

/** Reads metadata only. This function never creates Ghost storage or changes a host configuration. */
export async function inspectDoctorStorage(databasePath: string): Promise<DoctorStorageStatus> {
  return {
    databasePath,
    database: await inspectPrivatePath(databasePath),
    directory: await inspectPrivatePath(dirname(databasePath)),
  };
}

export function renderDoctorReport(report: DoctorReport): string {
  const lines = [
    'GhostD doctor (read-only)',
    `Runtime: Node ${report.nodeVersion} on ${report.platform}/${report.architecture}`,
    `Workspace: ${report.workspace}`,
    `Storage: ${renderStorage(report.storage)}`,
    'Provider CLIs:',
    ...report.providers.map((provider) => `- ${provider.displayName}: ${provider.installed ? `installed${provider.version === undefined ? '' : ` (${provider.version})`}` : `not detected; ${provider.packageName === undefined ? 'use its official installer' : `install with ghost providers install ${provider.provider}`}`}`),
    'Capture integrations:',
    ...report.captures.map((capture) => `- ${capture.host}: ${capture.configured ? `configured (${capture.configPath ?? 'path unavailable'})` : `not configured${capture.configPath === undefined ? '' : ` (${capture.configPath})`}`}`),
    `Default sidecar provider: ${report.configuration.defaultAnswerProvider ?? 'not configured; run ghost configure default <codex|claude|gemini>'}`,
    'Authentication and credentials: not inspected.',
    'Codex project trust: user confirmation required in Codex; GhostD cannot grant or bypass it.',
    'Recovery: run ghost setup for capture status, ghost session list to choose a captured session, and ghost setup remove <host> --approve to remove only GhostD capture.',
    'No changes were made.',
  ];
  return `${lines.join('\n')}\n`;
}

async function inspectPrivatePath(path: string): Promise<PrivatePathState> {
  try {
    const metadata = await stat(path);
    return (metadata.mode & 0o077) === 0 ? 'private' : 'accessible-by-group-or-others';
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return 'absent';
    throw error;
  }
}

function renderStorage(storage: DoctorStorageStatus): string {
  if (storage.database === 'absent') return `not initialized (${storage.databasePath}); run ghost setup when ready`;
  if (storage.directory === 'private' && storage.database === 'private') return `ready and owner-only (${storage.databasePath})`;
  return `exists but needs owner-only permissions (${storage.databasePath})`;
}
