import { readFile } from 'node:fs/promises';
import { createConnection } from 'node:net';

export const bridgeProtocol = 'ghostd/local-bridge/1';

export interface BridgeCredentials {
  clientId: string;
  token: string;
  workspaceCwd: string;
  endpoint: string;
  protocol: typeof bridgeProtocol;
}

interface BridgeResponse {
  protocol: typeof bridgeProtocol;
  id: string | number | null;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
}

const maxBridgeResponseBytes = 1024 * 1024;

export async function readBridgeCredentials(path: string): Promise<BridgeCredentials> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  if (!isRecord(parsed) || typeof parsed['clientId'] !== 'string' || typeof parsed['token'] !== 'string' || typeof parsed['workspaceCwd'] !== 'string' || typeof parsed['endpoint'] !== 'string' || parsed['protocol'] !== bridgeProtocol) {
    throw new Error('GhostD bridge credentials are invalid. Connect this workspace again.');
  }
  return {
    clientId: parsed['clientId'],
    token: parsed['token'],
    workspaceCwd: parsed['workspaceCwd'],
    endpoint: parsed['endpoint'],
    protocol: bridgeProtocol,
  };
}

export async function requestBridge(credentials: BridgeCredentials, method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await new Promise<BridgeResponse>((resolveResponse, rejectResponse) => {
    const socket = createConnection(credentials.endpoint);
    let buffered = '';
    let settled = false;
    const finish = (callback: () => void): void => {
      if (!settled) {
        settled = true;
        callback();
      }
    };
    socket.setEncoding('utf8');
    socket.once('error', (error) => finish(() => rejectResponse(error)));
    socket.on('data', (chunk: string) => {
      buffered += chunk;
      if (Buffer.byteLength(buffered, 'utf8') > maxBridgeResponseBytes) {
        socket.destroy();
        finish(() => rejectResponse(new Error('GhostD bridge response exceeds the extension safety limit.')));
        return;
      }
      const newline = buffered.indexOf('\n');
      if (newline === -1) return;
      try {
        finish(() => resolveResponse(JSON.parse(buffered.slice(0, newline)) as BridgeResponse));
      } catch {
        finish(() => rejectResponse(new Error('GhostD bridge returned invalid JSON.')));
      } finally {
        socket.end();
      }
    });
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ protocol: bridgeProtocol, id: 1, clientId: credentials.clientId, token: credentials.token, workspaceCwd: credentials.workspaceCwd, method, ...(params === undefined ? {} : { params }) })}\n`);
    });
  });
  if (!response.ok) throw new Error(response.error?.message ?? 'GhostD bridge request failed.');
  return response.result ?? {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
