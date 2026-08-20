import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createConnection, createServer } from 'node:net';
import type { Server, Socket } from 'node:net';

import { acpHandoff } from '../acp/handoff.js';
import { compileContext, renderContext } from '../context/compiler.js';
import type { BranchSynchronizationStatus } from '../core/graph.js';
import { GhostDatabase } from '../db/database.js';
import type { CapturedSession } from '../db/database.js';
import { redactText } from '../privacy/redaction.js';

export const localBridgeProtocol = 'ghostd/local-bridge/1';
export const bridgeCapabilityStates = ['supported and verified', 'installed but not configured', 'configured but inactive', 'unsupported'] as const;

export type BridgeCapabilityState = (typeof bridgeCapabilityStates)[number];

export interface BridgeCapability {
  host: string;
  state: BridgeCapabilityState;
  configPath?: string;
  reason?: string;
}

export interface LocalBridgeConfiguration {
  version: 1;
  endpoint: string;
  createdAt: string;
}

export interface LocalBridgeClientCredentials {
  clientId: string;
  token: string;
  workspaceCwd: string;
  endpoint: string;
  protocol: typeof localBridgeProtocol;
}

interface RegisteredBridgeClient {
  token: string;
  workspaceCwd: string;
  createdAt: string;
}

interface BridgeClientRegistryFile {
  version: 1;
  clients: Record<string, RegisteredBridgeClient>;
}

interface BridgeRequest {
  protocol: typeof localBridgeProtocol;
  id: string | number;
  clientId: string;
  token: string;
  workspaceCwd: string;
  method: string;
  params?: Record<string, unknown>;
}

interface BridgeResponse {
  protocol: typeof localBridgeProtocol;
  id: string | number | null;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
}

export interface LocalBridgeServerOptions {
  databasePath: string;
  configuration: LocalBridgeConfiguration;
  clientRegistry: LocalBridgeClientRegistry;
  capabilityResolver?: (workspaceCwd: string, sessions: readonly CapturedSession[]) => Promise<BridgeCapability[]>;
}

const maxRequestBytes = 64 * 1024;
const clientIdPattern = /^[A-Za-z0-9._-]{1,64}$/;

function defaultBridgeDirectory(): string {
  return process.env['GHOST_BRIDGE_HOME'] ?? join(homedir(), '.ghost');
}

function defaultEndpoint(directory: string): string {
  if (platform() === 'win32') {
    const suffix = Buffer.from(resolve(directory)).toString('hex').slice(0, 40);
    return `\\\\.\\pipe\\ghostd-${suffix}`;
  }
  return join(directory, 'bridge.sock');
}

function assertWorkspaceCwd(value: string): string {
  if (!isAbsolute(value) || resolve(value) !== value) {
    throw new Error('workspaceCwd must be an absolute normalized path.');
  }
  return value;
}

function assertClientId(value: string): string {
  if (!clientIdPattern.test(value)) throw new Error('clientId must contain only letters, numbers, dots, underscores, or hyphens.');
  return value;
}

/** Stores the non-secret local socket endpoint. The endpoint never leaves the local machine. */
export class LocalBridgeConfigurationStore {
  public constructor(
    private readonly path = join(defaultBridgeDirectory(), 'bridge.json'),
    private readonly endpoint = defaultEndpoint(dirname(path)),
  ) {}

  public async load(): Promise<LocalBridgeConfiguration | undefined> {
    try {
      return parseConfiguration(await readFile(this.path, 'utf8'));
    } catch (error: unknown) {
      if (isMissingFile(error)) return undefined;
      throw error;
    }
  }

  public async loadOrCreate(createdAt = new Date().toISOString()): Promise<LocalBridgeConfiguration> {
    const existing = await this.load();
    if (existing !== undefined) return existing;
    const configuration: LocalBridgeConfiguration = { version: 1, endpoint: this.endpoint, createdAt };
    await writePrivateJson(this.path, configuration);
    return configuration;
  }
}

/** Per-client capabilities are workspace-bound and persisted with owner-only filesystem permissions. */
export class LocalBridgeClientRegistry {
  public constructor(private readonly path = join(defaultBridgeDirectory(), 'bridge-clients.json')) {}

  public async register(clientId: string, workspaceCwd: string, endpoint: string, createdAt = new Date().toISOString()): Promise<LocalBridgeClientCredentials> {
    const id = assertClientId(clientId);
    const workspace = assertWorkspaceCwd(workspaceCwd);
    const registry = await this.load();
    const token = randomBytes(32).toString('hex');
    registry.clients[id] = { token, workspaceCwd: workspace, createdAt };
    await writePrivateJson(this.path, registry);
    return { clientId: id, token, workspaceCwd: workspace, endpoint, protocol: localBridgeProtocol };
  }

  public async revoke(clientId: string): Promise<boolean> {
    const id = assertClientId(clientId);
    const registry = await this.load();
    if (registry.clients[id] === undefined) return false;
    delete registry.clients[id];
    await writePrivateJson(this.path, registry);
    return true;
  }

  public async authenticate(clientId: string, token: string, workspaceCwd: string): Promise<boolean> {
    if (!clientIdPattern.test(clientId) || !isAbsolute(workspaceCwd) || resolve(workspaceCwd) !== workspaceCwd) return false;
    const client = (await this.load()).clients[clientId];
    if (client === undefined || client.workspaceCwd !== workspaceCwd || !isHexToken(token) || !isHexToken(client.token)) return false;
    return timingSafeEqual(Buffer.from(client.token, 'hex'), Buffer.from(token, 'hex'));
  }

  public async count(): Promise<number> {
    return Object.keys((await this.load()).clients).length;
  }

  private async load(): Promise<BridgeClientRegistryFile> {
    try {
      return parseRegistry(await readFile(this.path, 'utf8'));
    } catch (error: unknown) {
      if (isMissingFile(error)) return { version: 1, clients: {} };
      throw error;
    }
  }
}

/** Writes editor credentials directly to that editor's private storage. The token is never printed by GhostD. */
export async function writeLocalBridgeClientCredentials(path: string, credentials: LocalBridgeClientCredentials): Promise<void> {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error('Credential path must be an absolute normalized path.');
  parseClientCredentials(JSON.stringify(credentials));
  await writePrivateJson(path, credentials);
}

export async function readLocalBridgeClientCredentials(path: string): Promise<LocalBridgeClientCredentials> {
  return parseClientCredentials(await readFile(path, 'utf8'));
}

/** A local-only, authenticated JSON-lines bridge for editor clients. */
export class LocalBridgeServer {
  private server: Server | undefined;

  public constructor(private readonly options: LocalBridgeServerOptions) {}

  public async listen(): Promise<void> {
    if (this.server !== undefined) throw new Error('GhostD local bridge is already listening.');
    await removeStaleEndpoint(this.options.configuration.endpoint);
    const server = createServer((socket) => this.handleSocket(socket));
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(this.options.configuration.endpoint, () => {
        server.off('error', rejectListen);
        resolveListen();
      });
    });
    if (platform() !== 'win32') await chmod(this.options.configuration.endpoint, 0o600);
    this.server = server;
  }

  public async close(): Promise<void> {
    const server = this.server;
    if (server === undefined) return;
    this.server = undefined;
    await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error === undefined ? resolveClose() : rejectClose(error)));
    if (platform() !== 'win32') {
      try {
        await unlink(this.options.configuration.endpoint);
      } catch (error: unknown) {
        if (!isMissingFile(error)) throw error;
      }
    }
  }

  private handleSocket(socket: Socket): void {
    let buffered = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffered += chunk;
      if (Buffer.byteLength(buffered, 'utf8') > maxRequestBytes) {
        this.write(socket, failure(null, 'request_too_large', 'Request exceeds the local bridge limit.'));
        socket.destroy();
        return;
      }
      let newline = buffered.indexOf('\n');
      while (newline !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        void this.handleLine(socket, line);
        newline = buffered.indexOf('\n');
      }
    });
  }

  private async handleLine(socket: Socket, line: string): Promise<void> {
    let id: string | number | null = null;
    try {
      const request = parseRequest(line);
      id = request.id;
      if (!await this.options.clientRegistry.authenticate(request.clientId, request.token, request.workspaceCwd)) {
        this.write(socket, failure(id, 'unauthorized', 'Unauthorized local bridge client.'));
        return;
      }
      this.write(socket, { protocol: localBridgeProtocol, id, ok: true, result: await this.result(request) });
    } catch (error: unknown) {
      this.write(socket, failure(id, 'invalid_request', publicMessage(error)));
    }
  }

  private async result(request: BridgeRequest): Promise<Record<string, unknown>> {
    const database = await GhostDatabase.open(this.options.databasePath);
    try {
      const sessions = database.sessions(request.workspaceCwd);
      switch (request.method) {
        case 'initialize':
          return { protocol: localBridgeProtocol, capabilities: ['capture/status', 'sessions/list', 'sessions/select', 'context/read', 'branches/status', 'handoff/read'] };
        case 'capture/status':
          return { workspaceCwd: request.workspaceCwd, capabilities: await this.capabilities(request.workspaceCwd, sessions) };
        case 'sessions/list':
          return { workspaceCwd: request.workspaceCwd, selectedSessionId: database.activeSession(request.workspaceCwd)?.id ?? null, resolvedSessionId: database.resolvedSession(request.workspaceCwd)?.id ?? null, sessions };
        case 'sessions/select': {
          const selected = database.setActiveSession(request.workspaceCwd, requiredString(request.params, 'sessionId'));
          return { selectedSession: selected };
        }
        case 'context/read': {
          const requested = optionalString(request.params, 'sessionId');
          const session = requested === undefined ? database.resolvedSession(request.workspaceCwd) : database.session(requested);
          if (session === undefined) throw new Error('No captured session is resolved for this workspace.');
          if (session.workspaceCwd !== request.workspaceCwd) throw new Error('The requested session is outside this client workspace.');
          const context = renderContext(compileContext(database.eventsForSession(session.id)), optionalBoolean(request.params, 'provenance'));
          return { sessionId: session.id, context: redactText(context, 'storage').value };
        }
        case 'branches/status': {
          const status = database.branchSynchronizationStatus(requiredString(request.params, 'branch'));
          assertBranchWorkspace(database, status, request.workspaceCwd);
          return { status };
        }
        case 'handoff/read': {
          const branch = requiredString(request.params, 'branch');
          const status = database.branchSynchronizationStatus(branch);
          assertBranchWorkspace(database, status, request.workspaceCwd);
          return { handoff: redactHandoff(acpHandoff(database, branch)) };
        }
        default:
          throw new Error('Method not found.');
      }
    } finally {
      database.close();
    }
  }

  private async capabilities(workspaceCwd: string, sessions: readonly CapturedSession[]): Promise<BridgeCapability[]> {
    return this.options.capabilityResolver === undefined
      ? []
      : this.options.capabilityResolver(workspaceCwd, sessions);
  }

  private write(socket: Socket, response: BridgeResponse): void {
    if (!socket.destroyed) socket.write(`${JSON.stringify(response)}\n`);
  }
}

export async function requestLocalBridge(credentials: LocalBridgeClientCredentials, method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await new Promise<BridgeResponse>((resolveResponse, rejectResponse) => {
    const socket = createConnection(credentials.endpoint);
    let buffered = '';
    socket.setEncoding('utf8');
    socket.once('error', rejectResponse);
    socket.on('data', (chunk: string) => {
      buffered += chunk;
      const newline = buffered.indexOf('\n');
      if (newline === -1) return;
      try {
        resolveResponse(JSON.parse(buffered.slice(0, newline)) as BridgeResponse);
      } catch {
        rejectResponse(new Error('GhostD local bridge returned invalid JSON.'));
      } finally {
        socket.end();
      }
    });
    socket.once('connect', () => {
      const request: BridgeRequest = { protocol: localBridgeProtocol, id: 1, clientId: credentials.clientId, token: credentials.token, workspaceCwd: credentials.workspaceCwd, method, ...(params === undefined ? {} : { params }) };
      socket.write(`${JSON.stringify(request)}\n`);
    });
  });
  if (!response.ok) throw new Error(response.error?.message ?? 'GhostD local bridge request failed.');
  return response.result ?? {};
}

function parseConfiguration(value: string): LocalBridgeConfiguration {
  const parsed = jsonRecord(value, 'GhostD local bridge configuration');
  if (parsed['version'] !== 1 || typeof parsed['endpoint'] !== 'string' || parsed['endpoint'].trim().length === 0 || typeof parsed['createdAt'] !== 'string') {
    throw new Error('GhostD local bridge configuration is invalid.');
  }
  return { version: 1, endpoint: parsed['endpoint'], createdAt: parsed['createdAt'] };
}

function parseRegistry(value: string): BridgeClientRegistryFile {
  const parsed = jsonRecord(value, 'GhostD local bridge client registry');
  if (parsed['version'] !== 1 || typeof parsed['clients'] !== 'object' || parsed['clients'] === null || Array.isArray(parsed['clients'])) {
    throw new Error('GhostD local bridge client registry is invalid.');
  }
  const clients: Record<string, RegisteredBridgeClient> = {};
  for (const [clientId, rawClient] of Object.entries(parsed['clients'] as Record<string, unknown>)) {
    assertClientId(clientId);
    if (typeof rawClient !== 'object' || rawClient === null || Array.isArray(rawClient)) throw new Error('GhostD local bridge client registry is invalid.');
    const client = rawClient as Record<string, unknown>;
    if (!isHexToken(client['token']) || typeof client['workspaceCwd'] !== 'string' || typeof client['createdAt'] !== 'string') throw new Error('GhostD local bridge client registry is invalid.');
    clients[clientId] = { token: client['token'], workspaceCwd: assertWorkspaceCwd(client['workspaceCwd']), createdAt: client['createdAt'] };
  }
  return { version: 1, clients };
}

function parseClientCredentials(value: string): LocalBridgeClientCredentials {
  const parsed = jsonRecord(value, 'GhostD local bridge credentials');
  if (typeof parsed['clientId'] !== 'string' || !clientIdPattern.test(parsed['clientId']) || !isHexToken(parsed['token']) || typeof parsed['workspaceCwd'] !== 'string' || typeof parsed['endpoint'] !== 'string' || parsed['protocol'] !== localBridgeProtocol) {
    throw new Error('GhostD local bridge credentials are invalid.');
  }
  return {
    clientId: parsed['clientId'],
    token: parsed['token'],
    workspaceCwd: assertWorkspaceCwd(parsed['workspaceCwd']),
    endpoint: parsed['endpoint'],
    protocol: localBridgeProtocol,
  };
}

function parseRequest(line: string): BridgeRequest {
  const parsed = jsonRecord(line, 'Local bridge request');
  if (parsed['protocol'] !== localBridgeProtocol || (typeof parsed['id'] !== 'string' && typeof parsed['id'] !== 'number') || typeof parsed['clientId'] !== 'string' || typeof parsed['token'] !== 'string' || typeof parsed['workspaceCwd'] !== 'string' || typeof parsed['method'] !== 'string') {
    throw new Error('Invalid local bridge request.');
  }
  const params = parsed['params'];
  if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params))) throw new Error('Invalid local bridge request.');
  return { protocol: localBridgeProtocol, id: parsed['id'], clientId: parsed['clientId'], token: parsed['token'], workspaceCwd: assertWorkspaceCwd(parsed['workspaceCwd']), method: parsed['method'], ...(params === undefined ? {} : { params: params as Record<string, unknown> }) };
}

function jsonRecord(value: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${label} must be JSON.`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(`${label} must be an object.`);
  return parsed as Record<string, unknown>;
}

function requiredString(params: Record<string, unknown> | undefined, name: string): string {
  const value = params?.[name];
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${name} is required.`);
  return value;
}

function optionalString(params: Record<string, unknown> | undefined, name: string): string | undefined {
  const value = params?.[name];
  return value === undefined ? undefined : requiredString(params, name);
}

function optionalBoolean(params: Record<string, unknown> | undefined, name: string): boolean {
  const value = params?.[name];
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean.`);
  return value;
}

function assertBranchWorkspace(database: GhostDatabase, status: BranchSynchronizationStatus, workspaceCwd: string): void {
  const session = database.session(status.latestRevision.sessionId);
  if (session === undefined || session.workspaceCwd !== workspaceCwd) throw new Error('The requested branch is outside this client workspace.');
}

function redactHandoff(handoff: Record<string, unknown>): Record<string, unknown> {
  const context = handoff['context'];
  return typeof context === 'string' ? { ...handoff, context: redactText(context, 'storage').value } : handoff;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isHexToken(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function removeStaleEndpoint(endpoint: string): Promise<void> {
  if (platform() === 'win32') return;
  try {
    const entry = await stat(endpoint);
    if (!entry.isSocket()) throw new Error(`GhostD local bridge endpoint is not a socket: ${endpoint}`);
    const live = await endpointIsLive(endpoint);
    if (live) throw new Error(`GhostD local bridge is already running at ${endpoint}.`);
    await unlink(endpoint);
  } catch (error: unknown) {
    if (isMissingFile(error)) return;
    throw error;
  }
}

async function endpointIsLive(endpoint: string): Promise<boolean> {
  return new Promise((resolveLive) => {
    const socket = createConnection(endpoint);
    socket.once('connect', () => {
      socket.destroy();
      resolveLive(true);
    });
    socket.once('error', () => resolveLive(false));
  });
}

function failure(id: string | number | null, code: string, message: string): BridgeResponse {
  return { protocol: localBridgeProtocol, id, ok: false, error: { code, message } };
}

function publicMessage(error: unknown): string {
  return error instanceof Error && /^(No captured session|The requested session|The requested branch|sessionId is required|branch is required|provenance must be a boolean|Method not found)/.test(error.message)
    ? error.message
    : 'Invalid local bridge request.';
}
