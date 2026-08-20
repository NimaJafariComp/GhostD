import { createHash, randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { delimiter, dirname, isAbsolute, join } from 'node:path';

import * as vscode from 'vscode';

import { readBridgeCredentials, requestBridge } from './bridge-client.js';
import type { BridgeCredentials } from './bridge-client.js';

interface CapturedSession {
  id: string;
  source: string;
  sourceSessionId: string;
  workspaceCwd: string;
  endedAt?: string;
}

interface SessionState {
  sessions: CapturedSession[];
  selectedSessionId?: string;
  resolvedSessionId?: string;
  capabilities: string[];
}

interface DetectedAgentHost {
  name: string;
  extensionId: string;
  version: string;
  capture: 'supported' | 'unavailable';
  detail: string;
  captureHost?: 'codex' | 'claude';
}

const knownAgentExtensions: ReadonlyArray<Omit<DetectedAgentHost, 'version'>> = [
  {
    name: 'Gemini Code Assist',
    extensionId: 'google.geminicodeassist',
    capture: 'unavailable',
    detail: 'Detected, but this extension exposes no public session-event or lifecycle-hook API. GhostD will not read its private chat or storage.',
  },
  {
    name: 'Codex',
    extensionId: 'openai.chatgpt',
    capture: 'supported',
    detail: 'Detected. Configure the documented Codex project hook to capture sessions.',
    captureHost: 'codex',
  },
  {
    name: 'Claude Code',
    extensionId: 'anthropic.claude-code',
    capture: 'supported',
    detail: 'Detected. Configure the documented Claude Code project hook to capture sessions.',
    captureHost: 'claude',
  },
];

class GhostSessionItem extends vscode.TreeItem {
  public constructor(readonly session: CapturedSession, selected: boolean, resolved: boolean) {
    super(`${session.source}: ${session.sourceSessionId}`, vscode.TreeItemCollapsibleState.None);
    const state = session.endedAt === undefined ? 'open' : 'ended';
    this.description = [state, selected ? 'selected' : undefined, resolved ? 'resolved' : undefined].filter((value): value is string => value !== undefined).join(' · ');
    this.tooltip = `${session.source} session in ${session.workspaceCwd}`;
    this.contextValue = 'ghostdSession';
    this.command = { command: 'ghostd.selectSession', title: 'Select GhostD session', arguments: [session] };
  }
}

class GhostSessionsProvider implements vscode.TreeDataProvider<GhostSessionItem> {
  private readonly changed = new vscode.EventEmitter<GhostSessionItem | undefined>();
  public readonly onDidChangeTreeData = this.changed.event;
  private state: SessionState | undefined;
  private message = 'Connect this workspace to GhostD.';

  public setState(state: SessionState | undefined, message: string): void {
    this.state = state;
    this.message = message;
    this.changed.fire(undefined);
  }

  public getTreeItem(element: GhostSessionItem): vscode.TreeItem {
    return element;
  }

  public getChildren(): GhostSessionItem[] {
    if (this.state === undefined || this.state.sessions.length === 0) return [];
    return this.state.sessions.map((session) => new GhostSessionItem(session, session.id === this.state?.selectedSessionId, session.id === this.state?.resolvedSessionId));
  }

  public getParent(): undefined {
    return undefined;
  }

  public get messageText(): string {
    return this.message;
  }
}

class GhostdController implements vscode.Disposable {
  private readonly statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  private readonly output = vscode.window.createOutputChannel('GhostD');
  private readonly sessions = new GhostSessionsProvider();
  private readonly bridgeProcesses = new Map<string, ReturnType<typeof spawn>>();
  private sessionView: vscode.TreeView<GhostSessionItem> | undefined;

  public constructor(private readonly context: vscode.ExtensionContext) {
    this.statusBar.command = 'ghostd.connect';
    this.statusBar.text = '$(plug) GhostD: Connect';
    this.statusBar.tooltip = 'Connect this workspace to GhostD.';
    this.statusBar.show();
  }

  public get sessionsProvider(): GhostSessionsProvider {
    return this.sessions;
  }

  public setSessionView(sessionView: vscode.TreeView<GhostSessionItem>): void {
    this.sessionView = sessionView;
    this.sessionView.message = this.sessions.messageText;
  }

  public async connect(): Promise<void> {
    const workspace = await this.workspace();
    if (workspace === undefined) return;
    const approval = await vscode.window.showWarningMessage(
      'Connect GhostD for this workspace? GhostD will store a workspace-bound extension credential and read only captured session metadata and redacted GhostD context.',
      { modal: true },
      'Connect',
    );
    if (approval !== 'Connect') return;
    const credentialPath = this.credentialPath(workspace);
    const clientId = `vscode-${workspaceHash(workspace.uri.fsPath)}-${randomUUID().slice(0, 8)}`;
    await this.runGhost(['bridge', 'register', clientId, credentialPath, '--approve'], workspace);
    const credentials = await readBridgeCredentials(credentialPath);
    await this.ensureBridge(credentials, workspace);
    await this.refresh(workspace);
    vscode.window.showInformationMessage('GhostD connected to this workspace.');
  }

  public async configureCodex(): Promise<void> {
    await this.configureCapture('codex');
  }

  public async configureClaude(): Promise<void> {
    await this.configureCapture('claude');
  }

  public async configureGemini(): Promise<void> {
    await this.configureCapture('gemini');
  }

  private async configureCapture(host: 'codex' | 'claude' | 'gemini'): Promise<void> {
    const workspace = await this.workspace();
    if (workspace === undefined) return;
    const provider = host === 'codex' ? 'Codex' : host === 'claude' ? 'Claude Code' : 'Gemini CLI';
    const detail = host === 'codex'
      ? 'Codex project trust remains a separate user-controlled requirement.'
      : host === 'claude'
        ? 'Claude Code applies this project hook in its VS Code extension and CLI.'
        : 'This captures Gemini CLI sessions, including ones connected through the Gemini CLI Companion extension.';
    const approval = await vscode.window.showWarningMessage(
      `Configure the documented GhostD ${provider} project hook? ${detail}`,
      { modal: true },
      `Configure ${provider} capture`,
    );
    if (approval !== `Configure ${provider} capture`) return;
    await this.runGhost(['setup', host, '--approve'], workspace, host);
    vscode.window.showInformationMessage(host === 'codex'
      ? 'GhostD configured the Codex project hook. Approve project trust in Codex, then reload the Codex extension before hooks can run.'
      : host === 'claude'
        ? 'GhostD configured the Claude Code project hook. Start or resume a Claude Code VS Code session to begin capture.'
        : 'GhostD configured the Gemini CLI project hook. Start or resume a Gemini CLI session; it can use the Gemini CLI Companion extension for IDE context.');
    await this.refresh(workspace);
  }

  public async refresh(workspace?: vscode.WorkspaceFolder): Promise<void> {
    const resolvedWorkspace = workspace ?? await this.workspace();
    if (resolvedWorkspace === undefined) return;
    try {
      const credentials = await this.credentials(resolvedWorkspace);
      if (credentials === undefined) {
        this.sessions.setState(undefined, 'Connect this workspace to GhostD.');
        this.setSessionMessage();
        this.setStatus('$(plug) GhostD: Connect', 'Connect this workspace to GhostD.', 'ghostd.connect');
        return;
      }
      const [status, list] = await Promise.all([
        requestBridge(credentials, 'capture/status'),
        requestBridge(credentials, 'sessions/list'),
      ]);
      const sessions = readSessions(list['sessions']);
      const selectedSessionId = optionalString(list['selectedSessionId']);
      const resolvedSessionId = optionalString(list['resolvedSessionId']);
      const capabilities = readCapabilities(status['capabilities']);
      const state: SessionState = { sessions, ...(selectedSessionId === undefined ? {} : { selectedSessionId }), ...(resolvedSessionId === undefined ? {} : { resolvedSessionId }), capabilities };
      this.sessions.setState(state, sessions.length === 0 ? 'No captured sessions in this workspace.' : `${sessions.length} captured session${sessions.length === 1 ? '' : 's'}.`);
      this.setSessionMessage();
      if (resolvedSessionId !== undefined) {
        const resolved = sessions.find(({ id }) => id === resolvedSessionId);
        this.setStatus(`$(check) GhostD: ${resolved?.source ?? 'session'} active`, 'GhostD has an explicit or unambiguous selected session. Click to change it.', 'ghostd.selectSession');
      } else if (sessions.length > 0) {
        this.setStatus('$(warning) GhostD: Select session', 'More than one session is active, or no session is selected. Click to choose one.', 'ghostd.selectSession');
      } else {
        const codex = capabilities.find((capability) => capability === 'codex: installed but not configured');
        const configuredHost = capabilities.find((capability) => capability.endsWith(': configured but inactive'));
        const unavailableHost = this.detectedAgentHosts().find(({ capture }) => capture === 'unavailable');
        this.setStatus(
          configuredHost === undefined
            ? unavailableHost === undefined ? '$(circle-outline) GhostD: No capture' : `$(info) GhostD: ${unavailableHost.name} detected`
            : `$(check) GhostD: ${configuredHost.split(':', 1)[0] ?? 'host'} ready`,
          configuredHost === undefined
            ? unavailableHost === undefined
              ? codex === undefined ? 'No captured sessions in this workspace.' : 'Codex is installed but GhostD capture is not configured.'
              : unavailableHost.detail
            : 'A documented capture hook is configured. Start or resume a session in this host to begin capture.',
          configuredHost === undefined
            ? unavailableHost === undefined ? codex === undefined ? 'ghostd.refresh' : 'ghostd.configureCodex' : 'ghostd.showDetectedHosts'
            : 'ghostd.showDetectedHosts',
        );
      }
    } catch (error: unknown) {
      this.sessions.setState(undefined, 'GhostD bridge is unavailable. Reconnect this workspace to recover.');
      this.setSessionMessage();
      this.setStatus('$(error) GhostD: Reconnect', 'GhostD bridge is unavailable. Click to reconnect.', 'ghostd.connect');
      this.reportError(error);
    }
  }

  public async selectSession(session?: CapturedSession): Promise<void> {
    const workspace = await this.workspace();
    if (workspace === undefined) return;
    const credentials = await this.requireCredentials(workspace);
    if (credentials === undefined) return;
    const selected = session ?? await this.pickSession(credentials);
    if (selected === undefined) return;
    await requestBridge(credentials, 'sessions/select', { sessionId: selected.id });
    await this.refresh(workspace);
    vscode.window.showInformationMessage(`GhostD selected ${selected.source}: ${selected.sourceSessionId}.`);
  }

  public async showContext(): Promise<void> {
    const workspace = await this.workspace();
    if (workspace === undefined) return;
    const credentials = await this.requireCredentials(workspace);
    if (credentials === undefined) return;
    const result = await requestBridge(credentials, 'context/read', { provenance: true });
    const context = result['context'];
    if (typeof context !== 'string') throw new Error('GhostD bridge returned an invalid context response.');
    const document = await vscode.workspace.openTextDocument({ content: context, language: 'markdown' });
    await vscode.window.showTextDocument(document, { preview: true, preserveFocus: false });
  }

  public async copyHandoff(): Promise<void> {
    const workspace = await this.workspace();
    if (workspace === undefined) return;
    const credentials = await this.requireCredentials(workspace);
    if (credentials === undefined) return;
    const branch = await vscode.window.showInputBox({ prompt: 'Ghost branch to hand off', placeHolder: 'main' });
    if (branch === undefined || branch.trim().length === 0) return;
    const result = await requestBridge(credentials, 'handoff/read', { branch: branch.trim() });
    const handoff = result['handoff'];
    if (handoff === undefined) throw new Error('GhostD bridge returned an invalid handoff response.');
    await vscode.env.clipboard.writeText(JSON.stringify(handoff, null, 2));
    vscode.window.showInformationMessage(`GhostD copied the ${branch.trim()} handoff. No provider was invoked.`);
  }

  public async showDetectedHosts(): Promise<void> {
    const detected = this.detectedAgentHosts();
    if (detected.length === 0) {
      vscode.window.showInformationMessage('GhostD did not detect a known IDE agent extension in this VS Code host.');
      return;
    }
    const workspace = await this.workspace();
    const capabilities = workspace === undefined ? [] : await this.captureCapabilities(workspace);
    await vscode.window.showQuickPick(detected.map((host) => {
      const state = host.captureHost === undefined ? undefined : capabilities.find((capability) => capability.startsWith(`${host.captureHost}: `));
      return {
      label: host.name,
      description: `${host.extensionId} v${host.version} · ${state ?? `capture ${host.capture}`}`,
      detail: state === undefined ? host.detail : `${host.detail} Current GhostD capture state: ${state}.`,
      host,
    };
    }), { placeHolder: 'Detected IDE agent hosts. Detection never reads chat data.' });
  }

  public async disconnect(): Promise<void> {
    const workspace = await this.workspace();
    if (workspace === undefined) return;
    const credentials = await this.credentials(workspace);
    if (credentials === undefined) return;
    const approval = await vscode.window.showWarningMessage('Disconnect GhostD from this workspace and revoke this extension credential?', { modal: true }, 'Disconnect');
    if (approval !== 'Disconnect') return;
    await this.runGhost(['bridge', 'revoke', credentials.clientId, '--approve'], workspace);
    await vscode.workspace.fs.delete(vscode.Uri.file(this.credentialPath(workspace)), { useTrash: false });
    this.sessions.setState(undefined, 'Connect this workspace to GhostD.');
    this.setSessionMessage();
    this.setStatus('$(plug) GhostD: Connect', 'Connect this workspace to GhostD.', 'ghostd.connect');
    vscode.window.showInformationMessage('GhostD disconnected from this workspace.');
  }

  public dispose(): void {
    this.statusBar.dispose();
    this.output.dispose();
    for (const process of this.bridgeProcesses.values()) process.kill('SIGTERM');
  }

  private async workspace(): Promise<vscode.WorkspaceFolder | undefined> {
    const active = vscode.window.activeTextEditor;
    const activeWorkspace = active === undefined ? undefined : vscode.workspace.getWorkspaceFolder(active.document.uri);
    if (activeWorkspace !== undefined) return activeWorkspace;
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      vscode.window.showWarningMessage('Open a workspace folder before connecting GhostD.');
      return undefined;
    }
    if (folders.length === 1) return folders[0];
    const chosen = await vscode.window.showQuickPick(folders.map((folder) => ({ label: folder.name, description: folder.uri.fsPath, folder })), { placeHolder: 'Choose the workspace GhostD should use.' });
    return chosen?.folder;
  }

  private credentialPath(workspace: vscode.WorkspaceFolder): string {
    return join(this.context.globalStorageUri.fsPath, `bridge-${workspaceHash(workspace.uri.fsPath)}.json`);
  }

  private async credentials(workspace: vscode.WorkspaceFolder): Promise<BridgeCredentials | undefined> {
    const path = this.credentialPath(workspace);
    try {
      await access(path);
      const credentials = await readBridgeCredentials(path);
      return credentials.workspaceCwd === workspace.uri.fsPath ? credentials : undefined;
    } catch {
      return undefined;
    }
  }

  private async requireCredentials(workspace: vscode.WorkspaceFolder): Promise<BridgeCredentials | undefined> {
    const credentials = await this.credentials(workspace);
    if (credentials === undefined) {
      vscode.window.showWarningMessage('Connect this workspace to GhostD first.');
      return undefined;
    }
    return credentials;
  }

  private async pickSession(credentials: BridgeCredentials): Promise<CapturedSession | undefined> {
    const response = await requestBridge(credentials, 'sessions/list');
    const sessions = readSessions(response['sessions']);
    if (sessions.length === 0) {
      vscode.window.showInformationMessage('GhostD has no captured sessions in this workspace. Configure capture, then start an agent session.');
      return undefined;
    }
    const selection = await vscode.window.showQuickPick(sessions.map((session) => ({ label: `${session.source}: ${session.sourceSessionId}`, description: session.endedAt === undefined ? 'open' : 'ended', session })), { placeHolder: 'Select the GhostD session for this workspace.' });
    return selection?.session;
  }

  private async ensureBridge(credentials: BridgeCredentials, workspace: vscode.WorkspaceFolder): Promise<void> {
    try {
      await requestBridge(credentials, 'initialize');
      return;
    } catch {
      // A bridge may not be running yet. Start one only after the user's explicit Connect action.
    }
    const existing = this.bridgeProcesses.get(workspace.uri.fsPath);
    if (existing === undefined || existing.exitCode !== null) {
      const child = spawn(this.cliPath(workspace), ['bridge', 'serve'], { cwd: workspace.uri.fsPath, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
      child.stdout.on('data', (chunk: Buffer) => this.output.appendLine(chunk.toString().trimEnd()));
      child.stderr.on('data', (chunk: Buffer) => this.output.appendLine(chunk.toString().trimEnd()));
      this.bridgeProcesses.set(workspace.uri.fsPath, child);
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await delay(150);
      try {
        await requestBridge(credentials, 'initialize');
        return;
      } catch {
        // Wait for the local socket to appear, or for an existing bridge to accept the client.
      }
    }
    throw new Error('GhostD local bridge did not become available. Check the GhostD output channel.');
  }

  private async runGhost(arguments_: string[], workspace: vscode.WorkspaceFolder, host?: 'codex' | 'claude' | 'gemini'): Promise<string> {
    return new Promise((resolveRun, rejectRun) => {
      const child = spawn(this.cliPath(workspace), arguments_, { cwd: workspace.uri.fsPath, stdio: ['ignore', 'pipe', 'pipe'], shell: false, env: this.commandEnvironment(workspace, host) });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.once('error', (error) => rejectRun(new Error(`Could not run GhostD: ${error.message}`)));
      child.once('close', (code) => {
        if (code === 0) resolveRun(stdout);
        else rejectRun(new Error(stderr.trim().length === 0 ? `GhostD exited with code ${code ?? 'unknown'}.` : stderr.trim()));
      });
    });
  }

  private cliPath(workspace: vscode.WorkspaceFolder): string {
    return vscode.workspace.getConfiguration('ghostd', workspace.uri).get<string>('cliPath', 'ghost');
  }

  private detectedAgentHosts(): DetectedAgentHost[] {
    return knownAgentExtensions.flatMap((known) => {
      const extension = vscode.extensions.getExtension(known.extensionId);
      if (extension === undefined) return [];
      const version = typeof extension.packageJSON['version'] === 'string' ? extension.packageJSON['version'] : 'unknown';
      return [{ ...known, version }];
    });
  }

  private async captureCapabilities(workspace: vscode.WorkspaceFolder): Promise<string[]> {
    try {
      const credentials = await this.credentials(workspace);
      if (credentials === undefined) return [];
      return readCapabilities((await requestBridge(credentials, 'capture/status'))['capabilities']);
    } catch {
      return [];
    }
  }

  /**
   * VS Code's GUI extension host does not inherit every terminal shell path.
   * An explicit, absolute host CLI path is opt-in and only used while GhostD
   * verifies and installs that host's documented project hook.
   */
  private commandEnvironment(workspace: vscode.WorkspaceFolder, host?: 'codex' | 'claude' | 'gemini'): NodeJS.ProcessEnv {
    if (host === undefined) return process.env;
    const configuredPath = vscode.workspace.getConfiguration('ghostd', workspace.uri).get<string>(`${host}CliPath`, '').trim();
    if (!isAbsolute(configuredPath)) return process.env;
    const pathKey = process.platform === 'win32' && process.env['Path'] !== undefined ? 'Path' : 'PATH';
    const inheritedPath = process.env[pathKey] ?? '';
    return { ...process.env, [pathKey]: `${dirname(configuredPath)}${delimiter}${inheritedPath}` };
  }

  private setStatus(text: string, tooltip: string, command: string): void {
    this.statusBar.text = text;
    this.statusBar.tooltip = tooltip;
    this.statusBar.command = command;
    this.statusBar.show();
  }

  private setSessionMessage(): void {
    if (this.sessionView !== undefined) this.sessionView.message = this.sessions.messageText;
  }

  private reportError(error: unknown): void {
    const message = error instanceof Error ? error.message : 'Unexpected GhostD extension error.';
    this.output.appendLine(message);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const controller = new GhostdController(context);
  const sessionView = vscode.window.createTreeView('ghostd.sessions', { treeDataProvider: controller.sessionsProvider, showCollapseAll: false });
  controller.setSessionView(sessionView);
  context.subscriptions.push(
    controller,
    sessionView,
    vscode.commands.registerCommand('ghostd.connect', () => controller.connect().catch((error: unknown) => showCommandError(error))),
    vscode.commands.registerCommand('ghostd.configureCodex', () => controller.configureCodex().catch((error: unknown) => showCommandError(error))),
    vscode.commands.registerCommand('ghostd.configureClaude', () => controller.configureClaude().catch((error: unknown) => showCommandError(error))),
    vscode.commands.registerCommand('ghostd.configureGemini', () => controller.configureGemini().catch((error: unknown) => showCommandError(error))),
    vscode.commands.registerCommand('ghostd.selectSession', (session?: CapturedSession) => controller.selectSession(session).catch((error: unknown) => showCommandError(error))),
    vscode.commands.registerCommand('ghostd.showContext', () => controller.showContext().catch((error: unknown) => showCommandError(error))),
    vscode.commands.registerCommand('ghostd.copyHandoff', () => controller.copyHandoff().catch((error: unknown) => showCommandError(error))),
    vscode.commands.registerCommand('ghostd.showDetectedHosts', () => controller.showDetectedHosts().catch((error: unknown) => showCommandError(error))),
    vscode.commands.registerCommand('ghostd.disconnect', () => controller.disconnect().catch((error: unknown) => showCommandError(error))),
    vscode.commands.registerCommand('ghostd.refresh', () => controller.refresh().catch((error: unknown) => showCommandError(error))),
    vscode.window.onDidChangeActiveTextEditor(() => { void controller.refresh(); }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { void controller.refresh(); }),
  );
  void controller.refresh();
}

export function deactivate(): void {
  // VS Code disposes registered subscriptions, including the bridge process controller.
}

function workspaceHash(workspaceCwd: string): string {
  return createHash('sha256').update(workspaceCwd).digest('hex').slice(0, 24);
}

function readSessions(value: unknown): CapturedSession[] {
  if (!Array.isArray(value)) throw new Error('GhostD bridge returned an invalid sessions response.');
  return value.map((session) => {
    if (!isRecord(session) || typeof session['id'] !== 'string' || typeof session['source'] !== 'string' || typeof session['sourceSessionId'] !== 'string' || typeof session['workspaceCwd'] !== 'string' || (session['endedAt'] !== undefined && typeof session['endedAt'] !== 'string')) {
      throw new Error('GhostD bridge returned an invalid session.');
    }
    return { id: session['id'], source: session['source'], sourceSessionId: session['sourceSessionId'], workspaceCwd: session['workspaceCwd'], ...(session['endedAt'] === undefined ? {} : { endedAt: session['endedAt'] }) };
  });
}

function readCapabilities(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((capability) => isRecord(capability) && typeof capability['host'] === 'string' && typeof capability['state'] === 'string' ? [`${capability['host']}: ${capability['state']}`] : []);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function showCommandError(error: unknown): void {
  const message = error instanceof Error ? error.message : 'Unexpected GhostD extension error.';
  void vscode.window.showErrorMessage(message);
}
