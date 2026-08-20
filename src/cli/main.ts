#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { stdin as input, stdout as output } from 'node:process';

import { CodexAdapter } from '../adapters/codex/adapter.js';
import { hookCommand } from '../adapters/codex/setup.js';
import { ClaudeSourceAdapter } from '../adapters/claude/source.js';
import { GeminiSourceAdapter } from '../adapters/gemini/source.js';
import { capturableHosts, hostCaptureStatus, installHostCapture, removeHostCapture, unsupportedCaptureHosts } from '../adapters/host-setup.js';
import type { CapturableHost, CaptureHost } from '../adapters/host-setup.js';
import { ProviderCliManager, providerCliNames } from '../adapters/provider-cli.js';
import type { ProviderCliName } from '../adapters/provider-cli.js';
import { acpHandoff } from '../acp/handoff.js';
import { compileContext, renderContext } from '../context/compiler.js';
import { parseGhostEvent } from '../core/events.js';
import { GhostDatabase } from '../db/database.js';
import { IntegrationConfigStore, integrationProviders, providerModes } from '../ecosystem/config.js';
import type { IntegrationProvider, ProviderMode } from '../ecosystem/config.js';
import { installVsCodeTasks } from '../ecosystem/vscode.js';
import { MaterializationService } from '../materialization/service.js';
import { ComparisonService } from '../reasoning/service.js';
import { WriteBranchService } from '../write/service.js';
import { serveMcp } from '../mcp/server.js';

function databasePath(): string {
  return process.env['GHOST_DB_PATH'] ?? join(homedir(), '.ghost', 'ghost.db');
}

function selectedSessionId(database: GhostDatabase): string | undefined {
  return database.resolvedSession(process.cwd())?.id;
}

function requiredSelectedSessionId(database: GhostDatabase): string {
  const sessionId = selectedSessionId(database);
  if (sessionId === undefined) {
    throw new Error('No active Ghost session is resolved for this workspace. Run ghost session list, then ghost session use <id>.');
  }
  return sessionId;
}

function usage(): string {
  return `Usage:
  ghost ingest [event-file]  Store newline-delimited canonical Ghost events.
  ghost context [session-id] [--provenance]
                            Render a deterministic context handoff.
  ghost branch <name>       Create a cold logical branch from the latest session checkpoint.
  ghost branch close <name> Close a branch while preserving its history.
  ghost branch status <name>
                            Show pending synchronization and stale materializations.
  ghost rebase <branch>     Explicitly advance a branch to its latest captured revision.
  ghost ask claude <prompt> Ask Claude ephemerally from the latest session checkpoint.
  ghost ask gemini <prompt> Ask Gemini ephemerally from the latest session checkpoint.
  ghost ask <branch> <prompt>
                            Ask Claude from a persistent Ghost branch.
  ghost compare <branch> <prompt>
                            Run Claude and Gemini against one frozen branch revision.
  ghost copy <source> <new-branch>
                            Explicitly create a logical copy at the source branch revision.
  ghost merge <source> <target>
                            Explicitly fast-forward a same-session target branch.
  ghost switch <codex|claude|gemini> <branch>
                            Record and render a provider-independent continuation handoff.
  ghost worktree create <branch>
                            Create an isolated Git worktree for an open Ghost branch.
  ghost worktree status <branch>
                            Show worktree cleanliness, diff summary, and patch provenance.
  ghost worktree diff <branch>
                            Print an unpersisted Git diff for review.
  ghost worktree promote <branch> <target-git-branch> --approve
                            Explicitly fast-forward a reviewed committed patch into the checked-out target.
  ghost worktree close <branch>
                            Remove a clean Ghost-managed worktree while preserving its Git branch and audit history.
  ghost providers           Report which supported provider CLIs are installed.
  ghost providers install <codex|claude|gemini|missing>
                            Install selected missing provider CLIs from their official npm packages.
  ghost configure <codex|claude|gemini|antigravity> <subscription|api>
                            Record non-secret provider mode; credentials remain with the provider or environment.
  ghost acp handoff <branch> Emit a provider-neutral ACP handoff pinned to a Ghost revision.
  ghost mcp                  Run the read-only GhostD MCP server over standard input/output.
  ghost vscode setup         Add opt-in GhostD context and MCP tasks to this VS Code workspace.
  ghost setup                Initialize local storage and show supported host-capture status.
  ghost setup <host> --approve
                            Install documented project hooks for codex, claude, or gemini.
  ghost setup remove <host> --approve
                            Remove only GhostD's exact project hook command.
  ghost session list         List captured sessions in the current workspace.
  ghost session status       Show the selected and automatically resolvable session.
  ghost session use <id>     Explicitly select a captured session for this workspace.
  ghost codex-hook           Receive a Codex hook event on standard input.
  ghost claude-hook          Receive a Claude hook event on standard input.
  ghost gemini-hook          Receive a Gemini hook event on standard input.`;
}

function isProviderCliName(value: string): value is ProviderCliName {
  return providerCliNames.includes(value as ProviderCliName);
}

function isCapturableHost(value: string): value is CapturableHost { return capturableHosts.includes(value as CapturableHost); }
function isCaptureHost(value: string): value is CaptureHost { return [...capturableHosts, ...unsupportedCaptureHosts].includes(value as CaptureHost); }

function isIntegrationProvider(value: string): value is IntegrationProvider { return integrationProviders.includes(value as IntegrationProvider); }
function isProviderMode(value: string): value is ProviderMode { return providerModes.includes(value as ProviderMode); }

async function providers(arguments_: string[]): Promise<void> {
  const manager = new ProviderCliManager();
  if (arguments_.length === 0) {
    const statuses = await manager.statuses();
    for (const status of statuses) {
      const version = status.version === undefined ? '' : ` (${status.version})`;
      output.write(`${status.displayName}: ${status.installed ? `installed${version}` : 'not installed'}\n`);
    }
    output.write('Authentication is not inspected. Sign in through each installed provider CLI before using it.\n');
    return;
  }

  if (arguments_.at(0) !== 'install' || arguments_.length !== 2) {
    throw new Error('Usage: ghost providers [install <codex|claude|gemini|antigravity|missing>].');
  }
  const provider = arguments_.at(1);
  if (provider === 'missing') {
    const statuses = await manager.installMissing();
    output.write(`Provider CLIs ready: ${statuses.map((status) => status.provider).join(', ')}. Sign in through each provider CLI before using it.\n`);
    return;
  }
  if (provider === undefined || !isProviderCliName(provider)) {
    throw new Error('Choose codex, claude, gemini, antigravity, or missing.');
  }
  const status = await manager.install(provider);
  output.write(`${status.displayName} is installed. Sign in through its CLI before using it.\n`);
}

async function configure(arguments_: string[]): Promise<void> {
  const provider = arguments_.at(0);
  const mode = arguments_.at(1);
  if (provider === undefined || mode === undefined || arguments_.length !== 2 || !isIntegrationProvider(provider) || !isProviderMode(mode)) {
    throw new Error('Usage: ghost configure <codex|claude|gemini|antigravity> <subscription|api>.');
  }
  await new IntegrationConfigStore().setProvider(provider, mode);
  output.write(`Configured ${provider} for ${mode} mode. GhostD did not store any credential.\n`);
}

async function acp(arguments_: string[]): Promise<void> {
  if (arguments_.at(0) !== 'handoff' || arguments_.at(1) === undefined || arguments_.length !== 2) throw new Error('Usage: ghost acp handoff <branch>.');
  const database = await GhostDatabase.open(databasePath());
  try { output.write(`${JSON.stringify(acpHandoff(database, arguments_[1] as string), null, 2)}\n`); } finally { database.close(); }
}

async function vscode(arguments_: string[]): Promise<void> {
  if (arguments_.at(0) !== 'setup' || arguments_.length !== 1) throw new Error('Usage: ghost vscode setup.');
  const entryPath = process.argv[1];
  if (entryPath === undefined) throw new Error('Unable to determine the Ghost CLI entry path.');
  const taskPath = await installVsCodeTasks(process.cwd(), `${quoteForShell(process.execPath)} ${quoteForShell(resolve(entryPath))}`);
  output.write(`VS Code GhostD tasks installed: ${taskPath}\n`);
}

function quoteForShell(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

async function readIngestInput(filePath: string | undefined): Promise<string> {
  if (filePath !== undefined) {
    return readFile(filePath, 'utf8');
  }

  const chunks: Buffer[] = [];
  for await (const chunk of input) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function ingest(filePath: string | undefined): Promise<void> {
  const contents = await readIngestInput(filePath);
  const lines = contents.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    throw new Error('Expected at least one newline-delimited JSON event.');
  }

  const database = await GhostDatabase.open(databasePath());
  try {
    for (const [index, line] of lines.entries()) {
      let json: unknown;
      try {
        json = JSON.parse(line) as unknown;
      } catch {
        throw new Error(`Line ${index + 1} is not valid JSON.`);
      }
      database.append(parseGhostEvent(json));
    }
  } finally {
    database.close();
  }

  output.write(`Stored ${lines.length} event${lines.length === 1 ? '' : 's'} locally.\n`);
}

async function context(arguments_: string[]): Promise<void> {
  const includeProvenance = arguments_.includes('--provenance');
  const sessionId = arguments_.find((argument) => argument !== '--provenance');
  const database = await GhostDatabase.open(databasePath());
  try {
    const resolvedSessionId = sessionId ?? selectedSessionId(database);
    if (resolvedSessionId === undefined) {
      throw new Error('No active Ghost session is resolved for this workspace. Run ghost session list, then ghost session use <id>.');
    }
    const events = database.eventsForSession(resolvedSessionId);
    if (events.length === 0) {
      throw new Error(`No events found for session ${resolvedSessionId}.`);
    }
    output.write(`${renderContext(compileContext(events), includeProvenance)}\n`);
  } finally {
    database.close();
  }
}

async function branch(arguments_: string[]): Promise<void> {
  const database = await GhostDatabase.open(databasePath());
  try {
    if (arguments_.at(0) === 'close') {
      const name = arguments_.at(1);
      if (name === undefined || arguments_.length !== 2) {
        throw new Error('Usage: ghost branch close <name>.');
      }
      const closed = database.closeBranch(name);
      output.write(`Closed branch ${closed.name}; history remains available at revision ${closed.headRevisionId}.\n`);
      return;
    }
    if (arguments_.at(0) === 'status') {
      const name = arguments_.at(1);
      if (name === undefined || arguments_.length !== 2) {
        throw new Error('Usage: ghost branch status <name>.');
      }
      const status = database.branchSynchronizationStatus(name);
      output.write(
        `Branch ${status.branch.name}: ${status.pendingEventCount} pending event${status.pendingEventCount === 1 ? '' : 's'}, `
        + `${status.staleMaterializationCount} stale materialization${status.staleMaterializationCount === 1 ? '' : 's'}, `
        + `${status.rebaseRequired ? 'rebase required' : 'up to date'}.\n`,
      );
      return;
    }

    const name = arguments_.at(0);
    if (name === undefined || arguments_.length !== 1) {
      throw new Error('Usage: ghost branch <name>.');
    }
    const sessionId = requiredSelectedSessionId(database);
    const revision = database.createRevision(sessionId);
    const created = database.createBranch(name, revision.id);
    output.write(`Created cold branch ${created.name} at revision ${created.headRevisionId}.\n`);
  } finally {
    database.close();
  }
}

async function rebase(arguments_: string[]): Promise<void> {
  const name = arguments_.at(0);
  if (name === undefined || arguments_.length !== 1) {
    throw new Error('Usage: ghost rebase <branch>.');
  }
  const database = await GhostDatabase.open(databasePath());
  try {
    const result = database.rebaseBranch(name);
    if (!result.rebased) {
      output.write(`Branch ${name} is already at revision ${result.latestRevision.id}.\n`);
      return;
    }
    output.write(
      `Rebased ${name} onto revision ${result.latestRevision.id}; `
      + `${result.addedEventCount} captured event${result.addedEventCount === 1 ? '' : 's'} added. `
      + 'Earlier materializations remain preserved and may be stale.\n',
    );
  } finally {
    database.close();
  }
}

async function ask(arguments_: string[]): Promise<void> {
  const target = arguments_.at(0);
  const prompt = arguments_.slice(1).join(' ').trim();
  if (target === undefined || prompt.length === 0) {
    throw new Error('Usage: ghost ask <claude|gemini|branch> <prompt>.');
  }

  const database = await GhostDatabase.open(databasePath());
  let ephemeralBranchName: string | undefined;
  try {
    let branchName = target;
    let mode: 'ephemeral' | 'persistent' = 'persistent';
    let provider: 'claude' | 'gemini' = 'claude';
    if (target === 'claude' || target === 'gemini') {
      const sessionId = requiredSelectedSessionId(database);
      const revision = database.createRevision(sessionId);
      ephemeralBranchName = `ask-${randomUUID()}`;
      database.createBranch(ephemeralBranchName, revision.id, 'ephemeral');
      branchName = ephemeralBranchName;
      mode = 'ephemeral';
      provider = target;
    } else if (database.branch(branchName) === undefined) {
      throw new Error(`Unknown target ${target}. Use claude, gemini, or an existing branch name.`);
    }

    const service = new MaterializationService(database);
    const result = provider === 'claude'
      ? await service.askClaude({ branchName, prompt, mode })
      : await service.askGemini({ branchName, prompt, mode });
    output.write(`${result.text}\n\nGhost revision: ${result.revision.id}\nWorkspace snapshot: ${result.snapshot.id}\n`);
  } finally {
    if (ephemeralBranchName !== undefined) {
      database.closeBranch(ephemeralBranchName);
    }
    database.close();
  }
}

async function compare(arguments_: string[]): Promise<void> {
  const branchName = arguments_.at(0);
  const prompt = arguments_.slice(1).join(' ').trim();
  if (branchName === undefined || prompt.length === 0) {
    throw new Error('Usage: ghost compare <branch> <prompt>.');
  }
  const database = await GhostDatabase.open(databasePath());
  try {
    const result = await new ComparisonService(database).compare({ branchName, prompt });
    output.write(`Comparison ${result.run.id}: ${result.run.status} at revision ${result.run.frozenRevisionId}.\n`);
    for (const participant of result.participants) {
      output.write(`- ${participant.provider}: ${participant.status}\n`);
    }
    for (const insight of result.insights) {
      const evidence = insight.eventIds.length === 0 ? '' : ` [evidence: ${insight.eventIds.join(', ')}]`;
      output.write(`- ${insight.kind}: ${insight.text}${evidence}\n`);
    }
  } finally {
    database.close();
  }
}

async function copy(arguments_: string[]): Promise<void> {
  const source = arguments_.at(0);
  const destination = arguments_.at(1);
  if (source === undefined || destination === undefined || arguments_.length !== 2) {
    throw new Error('Usage: ghost copy <source> <new-branch>.');
  }
  const database = await GhostDatabase.open(databasePath());
  try {
    const result = database.copyBranch(source, destination);
    output.write(`Copied ${source} to ${destination} at revision ${result.revisionId}.\n`);
  } finally {
    database.close();
  }
}

async function merge(arguments_: string[]): Promise<void> {
  const source = arguments_.at(0);
  const target = arguments_.at(1);
  if (source === undefined || target === undefined || arguments_.length !== 2) {
    throw new Error('Usage: ghost merge <source> <target>.');
  }
  const database = await GhostDatabase.open(databasePath());
  try {
    const result = database.mergeBranches(source, target);
    output.write(result.merged
      ? `Merged ${source} into ${target} at revision ${result.headRevisionId}.\n`
      : `${target} is already at the same revision as ${source}.\n`);
  } finally {
    database.close();
  }
}

async function switchAgent(arguments_: string[]): Promise<void> {
  const targetAgent = arguments_.at(0);
  const branchName = arguments_.at(1);
  if (targetAgent === undefined || branchName === undefined || arguments_.length !== 2 || !['codex', 'claude', 'gemini'].includes(targetAgent)) {
    throw new Error('Usage: ghost switch <codex|claude|gemini> <branch>.');
  }
  const database = await GhostDatabase.open(databasePath());
  try {
    const handoff = database.switchAgent(branchName, targetAgent);
    const revision = database.revision(handoff.revisionId);
    if (revision === undefined) {
      throw new Error(`Switch ${handoff.id} references a missing revision.`);
    }
    const context = renderContext(
      compileContext(database.eventsForSessionThrough(revision.sessionId, revision.eventHighWaterMark)),
      true,
    );
    output.write(`Ghost handoff for ${targetAgent}\nRevision: ${revision.id}\nWorkspace snapshot: ${revision.workspaceSnapshotId}\n\n${context}\n`);
  } finally {
    database.close();
  }
}

async function worktree(arguments_: string[]): Promise<void> {
  const action = arguments_.at(0);
  const branchName = arguments_.at(1);
  if (action === undefined || branchName === undefined) {
    throw new Error('Usage: ghost worktree <create|status|diff|promote|close> <branch>.');
  }
  const database = await GhostDatabase.open(databasePath());
  const service = new WriteBranchService(database);
  try {
    switch (action) {
      case 'create': {
        if (arguments_.length !== 2) {
          throw new Error('Usage: ghost worktree create <branch>.');
        }
        const created = await service.create(branchName);
        output.write(`Created write worktree for ${branchName}: ${created.worktreePath}\nGit branch: ${created.gitBranch}\nBase commit: ${created.baseCommit}\n`);
        return;
      }
      case 'status': {
        if (arguments_.length !== 2) {
          throw new Error('Usage: ghost worktree status <branch>.');
        }
        const status = await service.status(branchName);
        output.write(
          `Worktree: ${status.worktree.worktreePath}\nGit branch: ${status.worktree.gitBranch}\n`
          + `HEAD: ${status.headCommit}\n${status.isClean ? 'Clean' : 'Dirty'}; ${status.changedFileCount} committed file${status.changedFileCount === 1 ? '' : 's'} changed from base.\n`
          + `${status.diffStat.length === 0 ? 'No committed diff.' : status.diffStat}\n`
          + `Patch provenance records: ${status.patches.length}\n`,
        );
        return;
      }
      case 'diff': {
        if (arguments_.length !== 2) {
          throw new Error('Usage: ghost worktree diff <branch>.');
        }
        const diff = await service.diff(branchName);
        output.write(diff.length === 0 ? 'No committed diff.\n' : `${diff}\n`);
        return;
      }
      case 'promote': {
        const targetGitBranch = arguments_.at(2);
        const approval = arguments_.at(3);
        if (targetGitBranch === undefined || approval !== '--approve' || arguments_.length !== 4) {
          throw new Error('Usage: ghost worktree promote <branch> <target-git-branch> --approve.');
        }
        const promotion = await service.promote(branchName, targetGitBranch, true);
        output.write(`Promoted ${branchName} into ${promotion.targetGitBranch} at ${promotion.targetAfterCommit}.\n`);
        return;
      }
      case 'close': {
        if (arguments_.length !== 2) {
          throw new Error('Usage: ghost worktree close <branch>.');
        }
        await service.close(branchName);
        output.write(`Closed write worktree for ${branchName}; Git branch and Ghost audit history remain preserved.\n`);
        return;
      }
      default:
        throw new Error('Usage: ghost worktree <create|status|diff|promote|close> <branch>.');
    }
  } finally {
    database.close();
  }
}

async function codexHook(): Promise<void> {
  const contents = await readIngestInput(undefined);
  let rawEvent: unknown;
  try {
    rawEvent = JSON.parse(contents) as unknown;
  } catch {
    throw new Error('Codex hook input is not valid JSON.');
  }

  const database = await GhostDatabase.open(databasePath());
  try {
    for (const event of new CodexAdapter().normalize(rawEvent as Record<string, unknown>)) {
      database.append(event);
    }
  } finally {
    database.close();
  }
}

async function claudeHook(): Promise<void> {
  const contents = await readIngestInput(undefined);
  let rawEvent: unknown;
  try {
    rawEvent = JSON.parse(contents) as unknown;
  } catch {
    throw new Error('Claude hook input is not valid JSON.');
  }
  if (typeof rawEvent !== 'object' || rawEvent === null || Array.isArray(rawEvent)) {
    throw new Error('Claude hook input must be a JSON object.');
  }
  const database = await GhostDatabase.open(databasePath());
  try {
    for (const event of new ClaudeSourceAdapter().normalize(rawEvent as Record<string, unknown>)) {
      database.append(event);
    }
  } finally {
    database.close();
  }
}

async function geminiHook(): Promise<void> {
  const contents = await readIngestInput(undefined);
  let rawEvent: unknown;
  try {
    rawEvent = JSON.parse(contents) as unknown;
  } catch {
    throw new Error('Gemini hook input is not valid JSON.');
  }
  if (typeof rawEvent !== 'object' || rawEvent === null || Array.isArray(rawEvent)) {
    throw new Error('Gemini hook input must be a JSON object.');
  }
  const database = await GhostDatabase.open(databasePath());
  try {
    for (const event of new GeminiSourceAdapter().normalize(rawEvent as Record<string, unknown>)) {
      database.append(event);
    }
  } finally {
    database.close();
  }
  output.write('{}\n');
}

function hostCommands(): Record<CapturableHost, string> {
  const entryPath = process.argv[1];
  if (entryPath === undefined) {
    throw new Error('Unable to determine the Ghost CLI entry path.');
  }
  const command = (hook: 'codex-hook' | 'claude-hook' | 'gemini-hook'): string => `${quoteForShell(process.execPath)} ${quoteForShell(resolve(entryPath))} ${hook}`;
  return {
    codex: hookCommand(process.execPath, resolve(entryPath)),
    claude: command('claude-hook'),
    gemini: command('gemini-hook'),
  };
}

async function session(arguments_: string[]): Promise<void> {
  const database = await GhostDatabase.open(databasePath());
  try {
    const workspace = process.cwd();
    switch (arguments_.at(0)) {
      case 'list': {
        if (arguments_.length !== 1) throw new Error('Usage: ghost session list.');
        const selected = database.activeSession(workspace)?.id;
        const sessions = database.sessions(workspace);
        if (sessions.length === 0) {
          output.write(`No captured sessions in ${workspace}. Enable a supported host with ghost setup <host> --approve.\n`);
          return;
        }
        for (const captured of sessions) {
          const state = captured.endedAt === undefined ? 'open' : `ended ${captured.endedAt}`;
          const selectedMarker = captured.id === selected ? ' selected' : '';
          output.write(`${captured.id}  ${captured.source}:${captured.sourceSessionId}  ${state}${selectedMarker}\n`);
        }
        return;
      }
      case 'status': {
        if (arguments_.length !== 1) throw new Error('Usage: ghost session status.');
        const selected = database.activeSession(workspace);
        const resolved = database.resolvedSession(workspace);
        const candidates = database.sessions(workspace).filter(({ endedAt }) => endedAt === undefined);
        output.write(`Workspace: ${workspace}\n`);
        output.write(`Selected: ${selected === undefined ? 'none' : `${selected.id} (${selected.source}:${selected.sourceSessionId})`}\n`);
        output.write(`Resolved: ${resolved === undefined ? 'none; select a session explicitly' : `${resolved.id} (${resolved.source}:${resolved.sourceSessionId})`}\n`);
        output.write(`Open captured sessions: ${candidates.length}\n`);
        return;
      }
      case 'use': {
        const sessionId = arguments_.at(1);
        if (sessionId === undefined || arguments_.length !== 2) throw new Error('Usage: ghost session use <id>.');
        const selected = database.setActiveSession(workspace, sessionId);
        output.write(`Selected ${selected.source}:${selected.sourceSessionId} for ${workspace}.\n`);
        return;
      }
      default:
        throw new Error('Usage: ghost session <list|status|use>.');
    }
  } finally {
    database.close();
  }
}

async function setup(arguments_: string[]): Promise<void> {
  const database = await GhostDatabase.open(databasePath());
  database.close();
  const commands = hostCommands();
  const [action, approval] = arguments_;
  if (action === undefined || action === 'status') {
    if (arguments_.length > (action === 'status' ? 1 : 0)) throw new Error('Usage: ghost setup [status|<codex|claude|gemini> --approve|remove <host> --approve].');
    const manager = new ProviderCliManager();
    const statuses = await manager.statuses();
    output.write(`Ghost storage ready: ${databasePath()}\n`);
    for (const provider of [...capturableHosts, ...unsupportedCaptureHosts]) {
      const installed = statuses.find(({ provider: name }) => name === provider)?.installed ?? false;
      const status = await hostCaptureStatus(provider, process.cwd(), commands);
      const configuration = status.captureSupported
        ? status.configured ? `capture configured at ${status.configPath}` : `capture not configured (${status.configPath})`
        : `capture unavailable: ${status.reason}`;
      output.write(`${provider}: ${installed ? 'CLI detected' : 'CLI not detected'}; ${configuration}\n`);
    }
    output.write('To modify one supported project integration, run: ghost setup <codex|claude|gemini> --approve. Codex project trust remains user-controlled.\n');
    return;
  }

  if (action === 'remove') {
    const host = arguments_.at(1);
    const confirmation = arguments_.at(2);
    if (host === undefined || confirmation !== '--approve' || arguments_.length !== 3 || !isCapturableHost(host)) {
      throw new Error('Usage: ghost setup remove <codex|claude|gemini> --approve.');
    }
    const removed = await removeHostCapture(host, process.cwd(), commands);
    output.write(removed ? `Removed GhostD ${host} capture hook from this project.\n` : `No GhostD ${host} capture hook is configured in this project.\n`);
    return;
  }

  if (arguments_.length !== 2 || approval !== '--approve' || !isCaptureHost(action)) {
    throw new Error('Usage: ghost setup [status|<codex|claude|gemini> --approve|remove <host> --approve].');
  }
  if (!isCapturableHost(action)) {
    throw new Error(`GhostD cannot configure ${action}: no verified source-capture contract is available.`);
  }
  const availability = await new ProviderCliManager().status(action);
  if (!availability.installed) {
    throw new Error(`${availability.displayName} is not detected. GhostD will not write a hook configuration for an unavailable host.`);
  }
  const hookPath = await installHostCapture(action, process.cwd(), commands);
  output.write(`GhostD ${action} capture hook installed: ${hookPath}\n`);
  output.write(action === 'codex'
    ? 'Approve this project in Codex before its hooks can run.\n'
    : `GhostD captures only documented ${availability.displayName} hook events. Use ghost session list and ghost session use <id> to control the active session.\n`);
}

async function main(): Promise<void> {
  const [command, ...arguments_] = process.argv.slice(2);
  switch (command) {
    case 'ingest':
      await ingest(arguments_.at(0));
      return;
    case 'context':
      await context(arguments_);
      return;
    case 'branch':
      await branch(arguments_);
      return;
    case 'rebase':
      await rebase(arguments_);
      return;
    case 'ask':
      await ask(arguments_);
      return;
    case 'compare':
      await compare(arguments_);
      return;
    case 'copy':
      await copy(arguments_);
      return;
    case 'merge':
      await merge(arguments_);
      return;
    case 'switch':
      await switchAgent(arguments_);
      return;
    case 'worktree':
      await worktree(arguments_);
      return;
    case 'providers':
      await providers(arguments_);
      return;
    case 'configure':
      await configure(arguments_);
      return;
    case 'acp':
      await acp(arguments_);
      return;
    case 'mcp':
      if (arguments_.length !== 0) throw new Error('Usage: ghost mcp.');
      await serveMcp(databasePath(), input, output);
      return;
    case 'vscode':
      await vscode(arguments_);
      return;
    case 'setup':
      await setup(arguments_);
      return;
    case 'session':
      await session(arguments_);
      return;
    case 'codex-hook':
      await codexHook();
      return;
    case 'claude-hook':
      await claudeHook();
      return;
    case 'gemini-hook':
      await geminiHook();
      return;
    case '--help':
    case '-h':
    case undefined:
      output.write(`${usage()}\n`);
      return;
    default:
      throw new Error(`Unknown command: ${command}.\n\n${usage()}`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unexpected Ghost failure.';
  process.stderr.write(`ghost: ${message}\n`);
  process.exitCode = 1;
});
