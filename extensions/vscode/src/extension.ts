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

interface DashboardSnapshot {
  workspace?: string;
  connected: boolean;
  sessions: CapturedSession[];
  capabilities: string[];
  detectedHosts: DetectedAgentHost[];
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
  private dashboard: vscode.WebviewPanel | undefined;

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

  public async openDashboard(): Promise<void> {
    if (this.dashboard === undefined) {
      const panel = vscode.window.createWebviewPanel('ghostd.dashboard', 'GhostD', vscode.ViewColumn.One, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'resources')],
      });
      panel.onDidDispose(() => { this.dashboard = undefined; }, undefined, this.context.subscriptions);
      panel.webview.onDidReceiveMessage((message: unknown) => { void this.handleDashboardMessage(message); }, undefined, this.context.subscriptions);
      this.dashboard = panel;
    }
    this.dashboard.reveal(vscode.ViewColumn.One, false);
    await this.updateDashboard();
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
    this.dashboard?.dispose();
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

  private async updateDashboard(): Promise<void> {
    const dashboard = this.dashboard;
    if (dashboard === undefined) return;
    const snapshot = await this.dashboardSnapshot();
    const logo = dashboard.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'ghostd-icon.png'));
    dashboard.webview.html = dashboardHtml(snapshot, logo.toString(), nonce());
  }

  private async dashboardSnapshot(): Promise<DashboardSnapshot> {
    const workspace = await this.workspace();
    const detectedHosts = this.detectedAgentHosts();
    if (workspace === undefined) return { connected: false, sessions: [], capabilities: [], detectedHosts };
    const credentials = await this.credentials(workspace);
    if (credentials === undefined) return { workspace: workspace.uri.fsPath, connected: false, sessions: [], capabilities: [], detectedHosts };
    try {
      const [status, list] = await Promise.all([
        requestBridge(credentials, 'capture/status'),
        requestBridge(credentials, 'sessions/list'),
      ]);
      return { workspace: workspace.uri.fsPath, connected: true, sessions: readSessions(list['sessions']), capabilities: readCapabilities(status['capabilities']), detectedHosts };
    } catch {
      return { workspace: workspace.uri.fsPath, connected: false, sessions: [], capabilities: [], detectedHosts };
    }
  }

  private async handleDashboardMessage(message: unknown): Promise<void> {
    if (!isRecord(message) || message['type'] !== 'action' || typeof message['action'] !== 'string') return;
    switch (message['action']) {
      case 'connect': await this.connect(); break;
      case 'configureCodex': await this.configureCodex(); break;
      case 'configureClaude': await this.configureClaude(); break;
      case 'configureGemini': await this.configureGemini(); break;
      case 'selectSession': await this.selectSession(); break;
      case 'showContext': await this.showContext(); break;
      case 'copyHandoff': await this.copyHandoff(); break;
      case 'disconnect': await this.disconnect(); break;
      case 'showHosts': await this.showDetectedHosts(); break;
      case 'refresh': await this.refresh(); break;
      default: return;
    }
    await this.updateDashboard();
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
    vscode.commands.registerCommand('ghostd.openDashboard', () => controller.openDashboard().catch((error: unknown) => showCommandError(error))),
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

function nonce(): string {
  return randomUUID().replaceAll('-', '');
}

function dashboardHtml(snapshot: DashboardSnapshot, logo: string, scriptNonce: string): string {
  const sessions = snapshot.sessions.length === 0
    ? '<p class="empty">No captured sessions yet. Configure a supported host, then start or resume its agent session.</p>'
    : `<ul>${snapshot.sessions.slice(0, 5).map((session) => `<li><strong>${escapeHtml(session.source)}</strong><span>${session.endedAt === undefined ? 'open' : 'ended'} · ${escapeHtml(session.sourceSessionId)}</span></li>`).join('')}</ul>`;
  const hosts = snapshot.detectedHosts.length === 0
    ? '<p class="empty">No known agent extensions detected in this IDE.</p>'
    : `<ul>${snapshot.detectedHosts.map((host) => {
      const capability = host.captureHost === undefined ? undefined : snapshot.capabilities.find((item) => item.startsWith(`${host.captureHost}: `));
      const status = capability ?? (host.capture === 'supported' ? 'setup needed' : 'capture unavailable');
      return `<li><span><strong>${escapeHtml(host.name)}</strong><small>${escapeHtml(host.extensionId)} v${escapeHtml(host.version)}</small></span><em class="${host.capture === 'supported' ? 'ready' : 'blocked'}">${escapeHtml(status)}</em></li>`;
    }).join('')}</ul>`;
  const connection = snapshot.connected ? 'Connected locally' : 'Not connected';
  const workspace = snapshot.workspace ?? 'Open a folder to begin';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${logo}; style-src 'unsafe-inline'; script-src 'nonce-${scriptNonce}';"><title>GhostD</title><style>
:root{color-scheme:dark light;font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background)}*{box-sizing:border-box}body{margin:0;padding:28px;max-width:980px}.hero{display:flex;gap:20px;align-items:center;padding:24px;background:linear-gradient(130deg,color-mix(in srgb,var(--vscode-editor-background) 82%,#165db4),var(--vscode-editor-background));border:1px solid var(--vscode-panel-border);border-radius:16px}.hero img{width:70px;height:70px}.eyebrow{text-transform:uppercase;letter-spacing:.12em;font:600 11px var(--vscode-editor-font-family);color:#4ed7ff;margin:0 0 5px}.hero h1{font-size:28px;margin:0}.hero p{margin:5px 0 0;line-height:1.45;color:var(--vscode-descriptionForeground)}.status{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:22px 0;padding:14px 16px;border-left:3px solid #46d6ff;background:var(--vscode-sideBar-background)}.status strong{display:block}.status span{font-size:12px;color:var(--vscode-descriptionForeground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:620px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(275px,1fr));gap:16px}.card{border:1px solid var(--vscode-panel-border);border-radius:12px;padding:18px;background:var(--vscode-editorWidget-background)}h2{font-size:14px;margin:0 0 12px}p,li{font-size:13px;line-height:1.5}.actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.actions button:first-child{grid-column:span 2}button{border:1px solid var(--vscode-button-border,transparent);border-radius:7px;padding:9px 10px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);font:600 12px var(--vscode-font-family);cursor:pointer}button.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}button:hover{background:var(--vscode-button-hoverBackground)}ul{list-style:none;margin:0;padding:0}li{display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-top:1px solid var(--vscode-panel-border)}li:first-child{border-top:0;padding-top:0}small,li span{display:block;font-size:11px;color:var(--vscode-descriptionForeground);font-family:var(--vscode-editor-font-family)}em{font-style:normal;font:600 11px var(--vscode-editor-font-family);white-space:nowrap}.ready{color:#48d597}.blocked{color:#e5ad55}.empty{color:var(--vscode-descriptionForeground);margin:0}.safety{margin-top:16px;padding:12px 14px;border-radius:8px;background:color-mix(in srgb,#7a45ff 13%,var(--vscode-editorWidget-background));color:var(--vscode-descriptionForeground)}.safety strong{color:var(--vscode-foreground)}code{font-family:var(--vscode-editor-font-family)}@media(max-width:500px){body{padding:16px}.hero{padding:18px}.actions{grid-template-columns:1fr}.actions button:first-child{grid-column:auto}.status{align-items:flex-start;flex-direction:column}}</style></head><body>
<header class="hero"><img src="${logo}" alt="GhostD"><div><p class="eyebrow">Local context ledger</p><h1>GhostD</h1><p>Keep agent context portable, revision-pinned, and out of the original chat.</p></div></header>
<section class="status"><div><strong>${escapeHtml(connection)}</strong><span>${escapeHtml(workspace)}</span></div><button data-action="refresh">Refresh</button></section>
<main class="grid"><section class="card"><h2>Actions</h2><div class="actions"><button class="primary" data-action="connect">Connect this workspace</button><button data-action="configureCodex">Configure Codex</button><button data-action="configureClaude">Configure Claude</button><button data-action="configureGemini">Configure Gemini CLI</button><button data-action="selectSession">Select session</button><button data-action="showContext">Show context</button><button data-action="copyHandoff">Copy branch handoff</button><button data-action="showHosts">Detected hosts</button><button data-action="disconnect">Disconnect</button></div></section><section class="card"><h2>Captured sessions</h2>${sessions}</section><section class="card"><h2>IDE agent hosts</h2>${hosts}</section><section class="card"><h2>Features &amp; terminal commands</h2><p>Capture documented lifecycle events, redact stored secrets, and create an exact context revision for sidecar questions.</p><p><code>ghost question "What is true now?"</code><br><code>ghost codex "…"</code> · <code>ghost claude "…"</code> · <code>ghost gemini "…"</code><br><code>ghost session list</code> · <code>ghost session use &lt;number&gt;</code></p></section></main><aside class="safety"><strong>Safety boundary.</strong> GhostD does not scrape chat panes, provider transcripts, credentials, window titles, or hidden extension storage. Detected hosts are not automatically captured.</aside>
<script nonce="${scriptNonce}">const vscode=acquireVsCodeApi();document.querySelectorAll('[data-action]').forEach((button)=>button.addEventListener('click',()=>vscode.postMessage({type:'action',action:button.dataset.action})));</script></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function showCommandError(error: unknown): void {
  const message = error instanceof Error ? error.message : 'Unexpected GhostD extension error.';
  void vscode.window.showErrorMessage(message);
}
