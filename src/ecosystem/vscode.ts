import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

interface TasksConfiguration { version?: string; tasks?: unknown[]; [key: string]: unknown; }

/** Adds opt-in VS Code tasks without overwriting user-defined tasks or extensions. */
export async function installVsCodeTasks(workspace: string, ghostCommand: string): Promise<string> {
  const path = join(workspace, '.vscode', 'tasks.json');
  let config: TasksConfiguration = {};
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('VS Code tasks configuration must be a JSON object.');
    config = parsed as TasksConfiguration;
  } catch (error: unknown) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
  const tasks = Array.isArray(config.tasks) ? [...config.tasks] : [];
  const required = [
    task('GhostD: Context', `${ghostCommand} context --provenance`),
    task('GhostD: MCP', `${ghostCommand} mcp`),
  ];
  for (const candidate of required) if (!tasks.some((existing) => hasTaskLabel(existing, candidate.label))) tasks.push(candidate);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ ...config, version: config.version ?? '2.0.0', tasks }, null, 2)}\n`, 'utf8');
  return path;
}

interface Task { label: string; type: 'shell'; command: string; problemMatcher: []; }
function task(label: string, command: string): Task { return { label, type: 'shell', command, problemMatcher: [] }; }
function hasTaskLabel(value: unknown, label: string): boolean { return typeof value === 'object' && value !== null && !Array.isArray(value) && (value as Record<string, unknown>)['label'] === label; }
