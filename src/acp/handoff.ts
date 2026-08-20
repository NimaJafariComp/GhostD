import { compileContext, renderContext } from '../context/compiler.js';
import { GhostDatabase } from '../db/database.js';

/** Provider-neutral ACP handoff payload. It carries Ghost state, never an opaque provider session. */
export function acpHandoff(database: GhostDatabase, branchName: string): Record<string, unknown> {
  const branch = database.branch(branchName);
  if (branch === undefined) throw new Error(`Branch ${branchName} does not exist.`);
  const revision = database.revision(branch.headRevisionId);
  if (revision === undefined) throw new Error(`Branch ${branchName} references a missing revision.`);
  return {
    protocol: 'ghostd/acp-handoff/1',
    sessionOwner: 'ghostd',
    providerSession: null,
    branch: branch.name,
    revision: revision.id,
    workspaceSnapshot: revision.workspaceSnapshotId,
    context: renderContext(compileContext(database.eventsForSessionThrough(revision.sessionId, revision.eventHighWaterMark)), true),
  };
}
