import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import { compileContext, renderContext } from '../context/compiler.js';
import { GhostDatabase } from '../db/database.js';

type RequestId = string | number;
interface JsonRpcRequest { jsonrpc: '2.0'; id?: RequestId; method: string; params?: Record<string, unknown>; }

/** Minimal standards-compliant local MCP surface. It exposes read-only Ghost context only. */
export class GhostMcpServer {
  public constructor(private readonly databasePath: string) {}

  public async handle(request: JsonRpcRequest): Promise<Record<string, unknown> | undefined> {
    if (request.id === undefined) return undefined;
    try {
      const result = await this.result(request.method, request.params ?? {});
      return { jsonrpc: '2.0', id: request.id, result };
    } catch (error: unknown) {
      return { jsonrpc: '2.0', id: request.id, error: { code: -32602, message: error instanceof Error ? error.message : 'Invalid request.' } };
    }
  }

  private async result(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (method === 'initialize') return { protocolVersion: '2025-06-18', serverInfo: { name: 'ghostd', version: '0.1.0' }, capabilities: { tools: {}, resources: {} } };
    if (method === 'tools/list') return { tools: tools() };
    if (method === 'resources/list') return { resources: [{ uri: 'ghost://context/latest', name: 'Latest Ghost context', mimeType: 'text/plain' }] };
    const database = await GhostDatabase.open(this.databasePath);
    try {
      if (method === 'resources/read') return resource(database, stringParameter(params, 'uri'));
      if (method === 'tools/call') return tool(database, stringParameter(params, 'name'), recordParameter(params, 'arguments'));
      throw new Error('Method not found.');
    } finally { database.close(); }
  }
}

export async function serveMcp(databasePath: string, input: Readable, output: Writable): Promise<void> {
  const server = new GhostMcpServer(databasePath);
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    try {
      const request = JSON.parse(line) as JsonRpcRequest;
      if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') throw new Error('Invalid JSON-RPC request.');
      const response = await server.handle(request);
      if (response !== undefined) output.write(`${JSON.stringify(response)}\n`);
    } catch {
      output.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error.' } })}\n`);
    }
  }
}

function tools(): Record<string, unknown>[] {
  return [
    { name: 'ghost_context', description: 'Read deterministic Ghost context for a captured session or the latest session.', inputSchema: { type: 'object', properties: { sessionId: { type: 'string' }, provenance: { type: 'boolean' } }, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
    { name: 'ghost_branch_status', description: 'Read synchronization status for a Ghost branch.', inputSchema: { type: 'object', properties: { branch: { type: 'string' } }, required: ['branch'], additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
  ];
}

function resource(database: GhostDatabase, uri: string): Record<string, unknown> {
  if (uri !== 'ghost://context/latest') throw new Error('Resource not found.');
  return { contents: [{ uri, mimeType: 'text/plain', text: context(database, undefined, true) }] };
}

function tool(database: GhostDatabase, name: string, arguments_: Record<string, unknown>): Record<string, unknown> {
  const structuredContent = name === 'ghost_context'
    ? { context: context(database, optionalString(arguments_, 'sessionId'), arguments_['provenance'] === true) }
    : name === 'ghost_branch_status'
      ? { status: database.branchSynchronizationStatus(stringParameter(arguments_, 'branch')) }
      : undefined;
  if (structuredContent === undefined) throw new Error('Tool not found.');
  return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent };
}

function context(database: GhostDatabase, requestedSessionId: string | undefined, provenance: boolean): string {
  const sessionId = requestedSessionId ?? database.latestSessionId();
  if (sessionId === undefined) throw new Error('No sessions have been captured.');
  return renderContext(compileContext(database.eventsForSession(sessionId)), provenance);
}

function stringParameter(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${name} is required.`);
  return value;
}
function optionalString(params: Record<string, unknown>, name: string): string | undefined { const value = params[name]; if (value === undefined) return undefined; return stringParameter(params, name); }
function recordParameter(params: Record<string, unknown>, name: string): Record<string, unknown> { const value = params[name]; return value === undefined ? {} : typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : (() => { throw new Error(`${name} must be an object.`); })(); }
