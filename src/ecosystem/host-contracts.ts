export const desktopHostIds = ['jetbrains', 'zed', 'other-desktop'] as const;

export type DesktopHostId = (typeof desktopHostIds)[number];
export type HostCaptureSupport = 'unsupported';

export interface DesktopHostContract {
  id: DesktopHostId;
  displayName: string;
  sourceCapture: HostCaptureSupport;
  activeSessionAwareness: HostCaptureSupport;
  reason: string;
  safeHandoffs: readonly ['ghost context', 'ghost mcp', 'ghost acp handoff'];
}

/**
 * Verified public-contract results. These are deliberately conservative: a client or extension API
 * is not a license to inspect another agent's private chat, transcript, or foreground state.
 */
export const desktopHostContracts: readonly DesktopHostContract[] = [
  {
    id: 'jetbrains',
    displayName: 'JetBrains IDEs',
    sourceCapture: 'unsupported',
    activeSessionAwareness: 'unsupported',
    reason: 'JetBrains exposes ACP client integration and plugin tool windows, but no public observer for an existing AI Chat conversation.',
    safeHandoffs: ['ghost context', 'ghost mcp', 'ghost acp handoff'],
  },
  {
    id: 'zed',
    displayName: 'Zed',
    sourceCapture: 'unsupported',
    activeSessionAwareness: 'unsupported',
    reason: 'Zed exposes new ACP agent threads, terminal threads, and MCP configuration, but no public observer for an existing agent thread.',
    safeHandoffs: ['ghost context', 'ghost mcp', 'ghost acp handoff'],
  },
  {
    id: 'other-desktop',
    displayName: 'Other desktop agents',
    sourceCapture: 'unsupported',
    activeSessionAwareness: 'unsupported',
    reason: 'No verified public observer or host-specific lifecycle, workspace, and session-identity contract is registered.',
    safeHandoffs: ['ghost context', 'ghost mcp', 'ghost acp handoff'],
  },
];

export function desktopHostContract(id: DesktopHostId): DesktopHostContract {
  const contract = desktopHostContracts.find((candidate) => candidate.id === id);
  if (contract === undefined) throw new Error(`Unknown desktop host: ${id}.`);
  return contract;
}
