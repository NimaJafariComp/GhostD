import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { deriveTrustClass } from '../core/events.js';
import type { GhostEvent } from '../core/events.js';
import type {
  BranchMaterialization,
  BranchRebase,
  BranchPersistence,
  BranchSynchronizationStatus,
  GhostBranch,
  GhostRevision,
  MaterializationStatus,
  RebaseResult,
  WorkspaceSnapshot,
} from '../core/graph.js';
import type {
  CompleteMaterializationRun,
  MaterializationRun,
  StartMaterializationRun,
} from '../core/materialization.js';
import type {
  AgentSwitch,
  BranchCopy,
  BranchMerge,
  BranchMergeResult,
  ComparisonInsight,
  ComparisonParticipant,
  ComparisonRun,
  InsightKind,
  InsightPayload,
} from '../core/reasoning.js';
import type {
  PatchProvenance,
  WritePromotion,
  WriteWorktree,
} from '../core/write.js';
import { redactEvent, redactText } from '../privacy/redaction.js';

export interface StoredEvent extends GhostEvent {
  sequence: number;
}

interface EventRow {
  id: string;
  session_id: string;
  sequence: number;
  schema_version: number;
  trust_class: string | null;
  timestamp: string;
  source: string;
  type: GhostEvent['type'];
  payload_json: string;
  workspace_cwd: string;
  git_head: string | null;
  git_status: string | null;
}

interface SessionIdRow {
  id: string;
}

interface SessionRow extends SessionIdRow {
  source: string;
  source_session_id: string;
  cwd: string;
  created_at: string;
  last_seen_at: string;
  ended_at: string | null;
}

export interface CapturedSession {
  id: string;
  source: string;
  sourceSessionId: string;
  workspaceCwd: string;
  createdAt: string;
  lastSeenAt: string;
  endedAt?: string;
}

interface ColumnRow {
  name: string;
}

interface RevisionRow {
  id: string;
  parent_revision_id: string | null;
  session_id: string;
  event_high_water_mark: number;
  workspace_snapshot_id: string;
  created_at: string;
}

interface WorkspaceSnapshotRow {
  id: string;
  cwd: string;
  git_head: string | null;
  git_status: string | null;
}

interface BranchRow {
  id: string;
  name: string;
  persistence: BranchPersistence;
  lifecycle: GhostBranch['lifecycle'];
  base_revision_id: string;
  head_revision_id: string;
  tracking_revision_id: string;
  originating_session_id: string;
  created_at: string;
  closed_at: string | null;
}

interface MaterializationRow {
  id: string;
  branch_id: string;
  provider: string;
  provider_handle: string | null;
  synchronized_revision_id: string;
  created_at: string;
  updated_at: string;
}

interface MaterializationRunRow {
  id: string;
  branch_id: string;
  provider: string;
  model: string;
  source_revision_id: string;
  mode: MaterializationRun['mode'];
  strategy: MaterializationRun['strategy'];
  status: MaterializationRun['status'];
  materialization_id: string | null;
  provider_handle: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  estimated_cost_usd: number | null;
  latency_ms: number | null;
  response_text: string | null;
  recovery: string;
  failure_code: string | null;
  created_at: string;
  completed_at: string | null;
}

interface BranchRebaseRow {
  id: string;
  branch_id: string;
  from_revision_id: string;
  to_revision_id: string;
  added_event_count: number;
  created_at: string;
}

interface ComparisonRunRow {
  id: string;
  branch_id: string;
  frozen_revision_id: string;
  workspace_snapshot_id: string;
  prompt: string;
  status: ComparisonRun['status'];
  created_at: string;
  completed_at: string | null;
}

interface ComparisonParticipantRow {
  id: string;
  comparison_run_id: string;
  provider: string;
  model: string;
  status: ComparisonParticipant['status'];
  provider_handle: string | null;
  response_text: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  latency_ms: number | null;
  failure_code: string | null;
  created_at: string;
  completed_at: string | null;
}

interface ComparisonInsightRow {
  id: string;
  comparison_run_id: string;
  participant_id: string;
  kind: InsightKind;
  text: string;
  event_ids_json: string;
  created_at: string;
}

interface BranchCopyRow {
  id: string;
  source_branch_id: string;
  copied_branch_id: string;
  revision_id: string;
  created_at: string;
}

interface BranchMergeRow {
  id: string;
  source_branch_id: string;
  target_branch_id: string;
  from_revision_id: string;
  to_revision_id: string;
  created_at: string;
}

interface AgentSwitchRow {
  id: string;
  branch_id: string;
  target_agent: string;
  revision_id: string;
  created_at: string;
}

interface WriteWorktreeRow {
  id: string;
  branch_id: string;
  repository_path: string;
  worktree_path: string;
  git_branch: string;
  base_commit: string;
  lifecycle: WriteWorktree['lifecycle'];
  created_at: string;
  closed_at: string | null;
}

interface PatchProvenanceRow {
  id: string;
  worktree_id: string;
  base_commit: string;
  head_commit: string;
  diff_sha256: string;
  changed_file_count: number;
  created_at: string;
}

interface WritePromotionRow {
  id: string;
  worktree_id: string;
  patch_id: string;
  target_git_branch: string;
  source_commit: string;
  target_before_commit: string;
  target_after_commit: string;
  created_at: string;
}

interface EventCheckpointRow {
  sequence: number;
  timestamp: string;
  workspace_cwd: string;
  git_head: string | null;
  git_status: string | null;
}

export class GhostDatabase {
  private readonly database: DatabaseSync;

  public constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec('PRAGMA journal_mode = WAL;');
    this.database.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  public static async open(path: string): Promise<GhostDatabase> {
    await mkdir(dirname(path), { recursive: true });
    return new GhostDatabase(path);
  }

  public close(): void {
    this.database.close();
  }

  public append(event: GhostEvent): void {
    const storedEvent = redactEvent(event, 'storage').value;
    const existing = this.database
      .prepare('SELECT id FROM events WHERE id = ?')
      .get(storedEvent.id) as SessionIdRow | undefined;
    if (existing !== undefined) {
      throw new Error(`Event ${storedEvent.id} already exists; events are append-only.`);
    }

    this.database.exec('BEGIN IMMEDIATE');
    try {
      const sessionId = this.canonicalSessionId(storedEvent);
      const now = storedEvent.timestamp;
      this.database
        .prepare(
        `INSERT INTO sessions (id, source, source_session_id, cwd, created_at, last_seen_at, ended_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             last_seen_at = excluded.last_seen_at,
             cwd = excluded.cwd,
             ended_at = CASE
               WHEN ? = 'session_start' THEN NULL
               WHEN excluded.ended_at IS NOT NULL THEN excluded.ended_at
               ELSE sessions.ended_at
             END`,
        )
        .run(
          sessionId,
          storedEvent.source,
          storedEvent.sessionId,
          storedEvent.workspace.cwd,
          now,
          now,
          storedEvent.type === 'session_end' ? now : null,
          storedEvent.type,
        );

      const next = this.database
        .prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM events WHERE session_id = ?')
        .get(sessionId) as { sequence: number };

      this.database
        .prepare(
          `INSERT INTO events (
             id, session_id, sequence, schema_version, timestamp, source, type, trust_class, payload_json,
             workspace_cwd, git_head, git_status
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          storedEvent.id,
          sessionId,
          next.sequence,
          storedEvent.schemaVersion,
          storedEvent.timestamp,
          storedEvent.source,
          storedEvent.type,
          storedEvent.trustClass,
          JSON.stringify(storedEvent.payload),
          storedEvent.workspace.cwd,
          storedEvent.workspace.gitHead ?? null,
          storedEvent.workspace.gitStatus ?? null,
        );
      this.database.exec('COMMIT');
    } catch (error: unknown) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  public latestSessionId(): string | undefined {
    const row = this.database
      .prepare('SELECT id, source, source_session_id, cwd, created_at, last_seen_at, ended_at FROM sessions ORDER BY last_seen_at DESC LIMIT 1')
      .get() as SessionRow | undefined;
    return row?.source_session_id;
  }

  public sessions(workspaceCwd?: string): CapturedSession[] {
    const rows = this.database
      .prepare(
        `SELECT id, source, source_session_id, cwd, created_at, last_seen_at, ended_at
         FROM sessions ${workspaceCwd === undefined ? '' : 'WHERE cwd = ?'}
         ORDER BY last_seen_at DESC, rowid DESC`,
      )
      .all(...(workspaceCwd === undefined ? [] : [workspaceCwd])) as unknown as SessionRow[];
    return rows.map(capturedSessionFromRow);
  }

  /** A user selection is the only durable active-session signal GhostD creates itself. */
  public setActiveSession(workspaceCwd: string, sessionId: string, selectedAt = new Date().toISOString()): CapturedSession {
    const session = this.session(sessionId);
    if (session === undefined) {
      throw new Error(`Session ${sessionId} does not exist.`);
    }
    if (session.workspaceCwd !== workspaceCwd) {
      throw new Error(`Session ${sessionId} belongs to ${session.workspaceCwd}, not the current workspace.`);
    }
    this.database
      .prepare(
        `INSERT INTO active_session_selections (workspace_cwd, session_id, selected_at)
         VALUES (?, ?, ?)
         ON CONFLICT(workspace_cwd) DO UPDATE SET session_id = excluded.session_id, selected_at = excluded.selected_at`,
      )
      .run(workspaceCwd, sessionId, selectedAt);
    return session;
  }

  public activeSession(workspaceCwd: string): CapturedSession | undefined {
    const row = this.database
      .prepare(
        `SELECT sessions.id, sessions.source, sessions.source_session_id, sessions.cwd, sessions.created_at, sessions.last_seen_at, sessions.ended_at
         FROM active_session_selections
         JOIN sessions ON sessions.id = active_session_selections.session_id
         WHERE active_session_selections.workspace_cwd = ?`,
      )
      .get(workspaceCwd) as SessionRow | undefined;
    return row === undefined ? undefined : capturedSessionFromRow(row);
  }

  /** Uses automatic selection only when exactly one currently open host session exists in this workspace. */
  public resolvedSession(workspaceCwd: string): CapturedSession | undefined {
    const selected = this.activeSession(workspaceCwd);
    if (selected !== undefined) {
      return selected;
    }
    const candidates = this.sessions(workspaceCwd).filter(({ endedAt }) => endedAt === undefined);
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  public session(sessionId: string): CapturedSession | undefined {
    const row = this.database
      .prepare('SELECT id, source, source_session_id, cwd, created_at, last_seen_at, ended_at FROM sessions WHERE id = ?')
      .get(sessionId) as SessionRow | undefined;
    return row === undefined ? undefined : capturedSessionFromRow(row);
  }

  public eventsForSession(sessionId: string): StoredEvent[] {
    return this.eventsForSessionThrough(sessionId);
  }

  public eventsForSessionThrough(sessionId: string, eventHighWaterMark?: number): StoredEvent[] {
    const storedSessionId = this.resolveStoredSessionId(sessionId);
    const rows = this.database
      .prepare(
        `SELECT id, session_id, sequence, schema_version, timestamp, source, type, trust_class, payload_json,
                workspace_cwd, git_head, git_status
         FROM events
         WHERE session_id = ? ${eventHighWaterMark === undefined ? '' : 'AND sequence <= ?'}
         ORDER BY sequence ASC`,
      )
      .all(...(eventHighWaterMark === undefined ? [storedSessionId] : [storedSessionId, eventHighWaterMark])) as unknown as EventRow[];

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      sequence: row.sequence,
      schemaVersion: row.schema_version as GhostEvent['schemaVersion'],
      timestamp: row.timestamp,
      source: row.source,
      type: row.type,
      trustClass: row.trust_class === null ? deriveTrustClass(row.type) : row.trust_class as GhostEvent['trustClass'],
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      workspace: {
        cwd: row.workspace_cwd,
        ...(row.git_head === null ? {} : { gitHead: row.git_head }),
        ...(row.git_status === null ? {} : { gitStatus: row.git_status }),
      },
    }));
  }

  /** Creates or returns an immutable checkpoint at a session event high-water mark. */
  public createRevision(sessionId: string, eventHighWaterMark?: number): GhostRevision {
    sessionId = this.resolveStoredSessionId(sessionId);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const checkpoint = eventHighWaterMark === undefined
        ? this.database
          .prepare(
            `SELECT sequence, timestamp, workspace_cwd, git_head, git_status
             FROM events WHERE session_id = ? ORDER BY sequence DESC LIMIT 1`,
          )
          .get(sessionId) as EventCheckpointRow | undefined
        : this.database
          .prepare(
            `SELECT sequence, timestamp, workspace_cwd, git_head, git_status
             FROM events WHERE session_id = ? AND sequence = ?`,
          )
          .get(sessionId, eventHighWaterMark) as EventCheckpointRow | undefined;
      if (checkpoint === undefined) {
        throw new Error(`No event checkpoint found for session ${sessionId}.`);
      }

      const existing = this.database
        .prepare(
          `SELECT id, parent_revision_id, session_id, event_high_water_mark, workspace_snapshot_id, created_at
           FROM revisions WHERE session_id = ? AND event_high_water_mark = ?`,
        )
        .get(sessionId, checkpoint.sequence) as RevisionRow | undefined;
      if (existing !== undefined) {
        this.database.exec('COMMIT');
        return revisionFromRow(existing);
      }

      const snapshot = snapshotFromCheckpoint(checkpoint);
      this.database
        .prepare(
          `INSERT INTO workspace_snapshots (id, cwd, git_head, git_status)
           VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
        )
        .run(snapshot.id, snapshot.cwd, snapshot.gitHead ?? null, snapshot.gitStatus ?? null);

      const parent = this.database
        .prepare('SELECT id FROM revisions WHERE session_id = ? AND event_high_water_mark < ? ORDER BY event_high_water_mark DESC LIMIT 1')
          .get(sessionId, checkpoint.sequence) as SessionIdRow | undefined;
      const revision: GhostRevision = {
        id: randomUUID(),
        ...(parent === undefined ? {} : { parentRevisionId: parent.id }),
        sessionId,
        eventHighWaterMark: checkpoint.sequence,
        workspaceSnapshotId: snapshot.id,
        createdAt: checkpoint.timestamp,
      };
      this.database
        .prepare(
          `INSERT INTO revisions (
             id, parent_revision_id, session_id, event_high_water_mark, workspace_snapshot_id, created_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          revision.id,
          revision.parentRevisionId ?? null,
          revision.sessionId,
          revision.eventHighWaterMark,
          revision.workspaceSnapshotId,
          revision.createdAt,
        );
      this.database.exec('COMMIT');
      return revision;
    } catch (error: unknown) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  public revision(id: string): GhostRevision | undefined {
    const row = this.database
      .prepare(
        `SELECT id, parent_revision_id, session_id, event_high_water_mark, workspace_snapshot_id, created_at
         FROM revisions WHERE id = ?`,
      )
      .get(id) as RevisionRow | undefined;
    return row === undefined ? undefined : revisionFromRow(row);
  }

  public workspaceSnapshot(id: string): WorkspaceSnapshot | undefined {
    const row = this.database
      .prepare('SELECT id, cwd, git_head, git_status FROM workspace_snapshots WHERE id = ?')
      .get(id) as WorkspaceSnapshotRow | undefined;
    return row === undefined ? undefined : workspaceSnapshotFromRow(row);
  }

  /** Creates a persistent or ephemeral logical branch without copying event history. */
  public createBranch(name: string, revisionId: string, persistence: BranchPersistence = 'persistent'): GhostBranch {
    if (name.trim().length === 0 || /\s/.test(name)) {
      throw new Error('Branch names must be non-empty and contain no whitespace.');
    }
    const revision = this.revision(revisionId);
    if (revision === undefined) {
      throw new Error(`Revision ${revisionId} does not exist.`);
    }
    const existing = this.branch(name);
    if (existing !== undefined) {
      throw new Error(`Branch ${name} already exists.`);
    }

    const branch: GhostBranch = {
      id: randomUUID(),
      name,
      persistence,
      lifecycle: 'open',
      baseRevisionId: revision.id,
      headRevisionId: revision.id,
      trackingRevisionId: revision.id,
      originatingSessionId: revision.sessionId,
      createdAt: revision.createdAt,
    };
    this.database
      .prepare(
        `INSERT INTO branches (
           id, name, persistence, lifecycle, base_revision_id, head_revision_id, tracking_revision_id,
           originating_session_id, created_at, closed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        branch.id,
        branch.name,
        branch.persistence,
        branch.lifecycle,
        branch.baseRevisionId,
        branch.headRevisionId,
        branch.trackingRevisionId,
        branch.originatingSessionId,
        branch.createdAt,
      );
    return { ...branch, originatingSessionId: this.sourceSessionId(branch.originatingSessionId) };
  }

  public branch(name: string): GhostBranch | undefined {
    const row = this.database
      .prepare(
        `SELECT id, name, persistence, lifecycle, base_revision_id, head_revision_id, tracking_revision_id,
                originating_session_id, created_at, closed_at
         FROM branches WHERE name = ?`,
      )
      .get(name) as BranchRow | undefined;
    return row === undefined ? undefined : this.branchFromRow(row);
  }

  /** Closing a branch changes its lifecycle only; all history and materializations remain available. */
  public closeBranch(name: string, closedAt = new Date().toISOString()): GhostBranch {
    const branch = this.branch(name);
    if (branch === undefined) {
      throw new Error(`Branch ${name} does not exist.`);
    }
    if (branch.lifecycle === 'closed') {
      return branch;
    }
    this.database
      .prepare('UPDATE branches SET lifecycle = ?, closed_at = ? WHERE id = ?')
      .run('closed', closedAt, branch.id);
    return { ...branch, lifecycle: 'closed', closedAt };
  }

  /** Records a provider handle against an exact reachable revision; handles may be omitted or later discarded. */
  public recordMaterialization(
    branchName: string,
    provider: string,
    synchronizedRevisionId: string,
    providerHandle?: string,
    timestamp = new Date().toISOString(),
  ): BranchMaterialization {
    if (provider.trim().length === 0) {
      throw new Error('A materialization provider is required.');
    }
    const branch = this.branch(branchName);
    if (branch === undefined) {
      throw new Error(`Branch ${branchName} does not exist.`);
    }
    if (branch.lifecycle !== 'open') {
      throw new Error(`Branch ${branchName} is closed.`);
    }
    if (!this.isRevisionAncestor(synchronizedRevisionId, branch.headRevisionId)) {
      throw new Error(`Revision ${synchronizedRevisionId} is not reachable from branch ${branchName}.`);
    }

    const materialization: BranchMaterialization = {
      id: randomUUID(),
      branchId: branch.id,
      provider,
      ...(providerHandle === undefined ? {} : { providerHandle }),
      synchronizedRevisionId,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.database
      .prepare(
        `INSERT INTO branch_materializations (
           id, branch_id, provider, provider_handle, synchronized_revision_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        materialization.id,
        materialization.branchId,
        materialization.provider,
        materialization.providerHandle ?? null,
        materialization.synchronizedRevisionId,
        materialization.createdAt,
        materialization.updatedAt,
      );
    return materialization;
  }

  public materializationStatus(id: string): MaterializationStatus | undefined {
    const row = this.database
      .prepare(
        `SELECT id, branch_id, provider, provider_handle, synchronized_revision_id, created_at, updated_at
         FROM branch_materializations WHERE id = ?`,
      )
      .get(id) as MaterializationRow | undefined;
    if (row === undefined) {
      return undefined;
    }
    const materialization = materializationFromRow(row);
    const branch = this.database
      .prepare(
        `SELECT id, name, persistence, lifecycle, base_revision_id, head_revision_id, tracking_revision_id,
                originating_session_id, created_at, closed_at
         FROM branches WHERE id = ?`,
      )
      .get(materialization.branchId) as BranchRow | undefined;
    if (branch === undefined) {
      throw new Error(`Materialization ${id} has no branch.`);
    }
    return {
      materialization,
      stale: !this.isRevisionAncestor(materialization.synchronizedRevisionId, branch.head_revision_id)
        || materialization.synchronizedRevisionId !== branch.head_revision_id,
    };
  }

  /**
   * Lazily checkpoints newly captured events. It never moves a branch: the caller must
   * explicitly rebase to accept that newer canonical revision.
   */
  public branchSynchronizationStatus(name: string): BranchSynchronizationStatus {
    const branch = this.branch(name);
    if (branch === undefined) {
      throw new Error(`Branch ${name} does not exist.`);
    }
    const latestRevision = this.latestRevisionForBranch(branch);
    const trackingRevision = this.revision(branch.trackingRevisionId);
    if (trackingRevision === undefined) {
      throw new Error(`Branch ${name} references a missing tracking revision.`);
    }
    const materializations = this.branchMaterializations(branch.id);
    return {
      branch,
      latestRevision,
      pendingEventCount: Math.max(0, latestRevision.eventHighWaterMark - trackingRevision.eventHighWaterMark),
      rebaseRequired: branch.headRevisionId !== latestRevision.id,
      staleMaterializationCount: materializations.filter(({ synchronizedRevisionId }) => synchronizedRevisionId !== branch.headRevisionId).length,
    };
  }

  /** Rebase is explicit: it advances a branch pointer but never rewrites canonical history. */
  public rebaseBranch(name: string, rebasedAt = new Date().toISOString()): RebaseResult {
    const branch = this.branch(name);
    if (branch === undefined) {
      throw new Error(`Branch ${name} does not exist.`);
    }
    if (branch.lifecycle !== 'open') {
      throw new Error(`Branch ${name} is closed.`);
    }
    const latestRevision = this.latestRevisionForBranch(branch);
    const currentRevision = this.revision(branch.headRevisionId);
    if (currentRevision === undefined) {
      throw new Error(`Branch ${name} references a missing head revision.`);
    }
    const addedEventCount = Math.max(0, latestRevision.eventHighWaterMark - currentRevision.eventHighWaterMark);
    if (latestRevision.id === branch.headRevisionId) {
      return { branch, latestRevision, addedEventCount, rebased: false };
    }
    if (!this.isRevisionAncestor(branch.headRevisionId, latestRevision.id)) {
      throw new Error(`Branch ${name} cannot rebase onto an unrelated revision.`);
    }

    const rebase: BranchRebase = {
      id: randomUUID(),
      branchId: branch.id,
      fromRevisionId: branch.headRevisionId,
      toRevisionId: latestRevision.id,
      addedEventCount,
      createdAt: rebasedAt,
    };
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database
        .prepare('UPDATE branches SET head_revision_id = ?, tracking_revision_id = ? WHERE id = ?')
        .run(latestRevision.id, latestRevision.id, branch.id);
      this.database
        .prepare(
          `INSERT INTO branch_rebases (
             id, branch_id, from_revision_id, to_revision_id, added_event_count, created_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(rebase.id, rebase.branchId, rebase.fromRevisionId, rebase.toRevisionId, rebase.addedEventCount, rebase.createdAt);
      this.database.exec('COMMIT');
    } catch (error: unknown) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    const rebasedBranch = { ...branch, headRevisionId: latestRevision.id, trackingRevisionId: latestRevision.id };
    return { branch: rebasedBranch, latestRevision, addedEventCount, rebased: true, rebase };
  }

  public rebasesForBranch(name: string): BranchRebase[] {
    const branch = this.branch(name);
    if (branch === undefined) {
      throw new Error(`Branch ${name} does not exist.`);
    }
    const rows = this.database
      .prepare(
        `SELECT id, branch_id, from_revision_id, to_revision_id, added_event_count, created_at
         FROM branch_rebases WHERE branch_id = ? ORDER BY created_at ASC, rowid ASC`,
      )
      .all(branch.id) as unknown as BranchRebaseRow[];
    return rows.map(branchRebaseFromRow);
  }

  /** Creates an immutable comparison request pinned to the branch's current revision. */
  public createComparisonRun(branchName: string, prompt: string, createdAt = new Date().toISOString()): ComparisonRun {
    if (prompt.trim().length === 0) {
      throw new Error('A comparison prompt is required.');
    }
    const branch = this.branch(branchName);
    if (branch === undefined) {
      throw new Error(`Branch ${branchName} does not exist.`);
    }
    if (branch.lifecycle !== 'open') {
      throw new Error(`Branch ${branchName} is closed.`);
    }
    const revision = this.revision(branch.headRevisionId);
    if (revision === undefined) {
      throw new Error(`Branch ${branchName} references a missing head revision.`);
    }
    const run: ComparisonRun = {
      id: randomUUID(),
      branchId: branch.id,
      frozenRevisionId: revision.id,
      workspaceSnapshotId: revision.workspaceSnapshotId,
      prompt: redactText(prompt, 'storage').value,
      status: 'running',
      createdAt,
    };
    this.database
      .prepare(
        `INSERT INTO comparison_runs (
           id, branch_id, frozen_revision_id, workspace_snapshot_id, prompt, status, created_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(run.id, run.branchId, run.frozenRevisionId, run.workspaceSnapshotId, run.prompt, run.status, run.createdAt);
    return run;
  }

  public comparisonRun(id: string): ComparisonRun | undefined {
    const row = this.database
      .prepare(
        `SELECT id, branch_id, frozen_revision_id, workspace_snapshot_id, prompt, status, created_at, completed_at
         FROM comparison_runs WHERE id = ?`,
      )
      .get(id) as ComparisonRunRow | undefined;
    return row === undefined ? undefined : comparisonRunFromRow(row);
  }

  public startComparisonParticipant(comparisonRunId: string, provider: string, model: string, createdAt = new Date().toISOString()): ComparisonParticipant {
    const run = this.comparisonRun(comparisonRunId);
    if (run === undefined) {
      throw new Error(`Comparison run ${comparisonRunId} does not exist.`);
    }
    if (run.status !== 'running') {
      throw new Error(`Comparison run ${comparisonRunId} is already ${run.status}.`);
    }
    if (provider.trim().length === 0 || model.trim().length === 0) {
      throw new Error('A comparison participant requires provider and model names.');
    }
    const participant: ComparisonParticipant = {
      id: randomUUID(),
      comparisonRunId,
      provider,
      model,
      status: 'running',
      createdAt,
    };
    this.database
      .prepare(
        `INSERT INTO comparison_participants (
           id, comparison_run_id, provider, model, status, provider_handle, response_text,
           input_tokens, output_tokens, latency_ms, failure_code, created_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL)`,
      )
      .run(participant.id, participant.comparisonRunId, participant.provider, participant.model, participant.status, participant.createdAt);
    return participant;
  }

  public completeComparisonParticipant(
    id: string,
    outcome: Omit<ComparisonParticipant, 'id' | 'comparisonRunId' | 'provider' | 'model' | 'status' | 'createdAt'> & { responseText: string; completedAt: string },
  ): ComparisonParticipant {
    const participant = this.comparisonParticipant(id);
    if (participant === undefined) {
      throw new Error(`Comparison participant ${id} does not exist.`);
    }
    if (participant.status !== 'running') {
      throw new Error(`Comparison participant ${id} is already ${participant.status}.`);
    }
    const responseText = redactText(outcome.responseText, 'storage').value;
    this.database
      .prepare(
        `UPDATE comparison_participants
         SET status = ?, provider_handle = ?, response_text = ?, input_tokens = ?, output_tokens = ?, latency_ms = ?, completed_at = ?
         WHERE id = ?`,
      )
      .run(
        'succeeded',
        outcome.providerHandle ?? null,
        responseText,
        outcome.inputTokens ?? null,
        outcome.outputTokens ?? null,
        outcome.latencyMs ?? null,
        outcome.completedAt,
        id,
      );
    return {
      ...participant,
      status: 'succeeded',
      ...(outcome.providerHandle === undefined ? {} : { providerHandle: outcome.providerHandle }),
      responseText,
      ...(outcome.inputTokens === undefined ? {} : { inputTokens: outcome.inputTokens }),
      ...(outcome.outputTokens === undefined ? {} : { outputTokens: outcome.outputTokens }),
      ...(outcome.latencyMs === undefined ? {} : { latencyMs: outcome.latencyMs }),
      completedAt: outcome.completedAt,
    };
  }

  public failComparisonParticipant(id: string, failureCode: string, completedAt: string, latencyMs?: number): ComparisonParticipant {
    const participant = this.comparisonParticipant(id);
    if (participant === undefined) {
      throw new Error(`Comparison participant ${id} does not exist.`);
    }
    if (participant.status !== 'running') {
      throw new Error(`Comparison participant ${id} is already ${participant.status}.`);
    }
    this.database
      .prepare('UPDATE comparison_participants SET status = ?, failure_code = ?, latency_ms = ?, completed_at = ? WHERE id = ?')
      .run('failed', failureCode, latencyMs ?? null, completedAt, id);
    return { ...participant, status: 'failed', failureCode, ...(latencyMs === undefined ? {} : { latencyMs }), completedAt };
  }

  public comparisonParticipant(id: string): ComparisonParticipant | undefined {
    const row = this.database
      .prepare(
        `SELECT id, comparison_run_id, provider, model, status, provider_handle, response_text,
                input_tokens, output_tokens, latency_ms, failure_code, created_at, completed_at
         FROM comparison_participants WHERE id = ?`,
      )
      .get(id) as ComparisonParticipantRow | undefined;
    return row === undefined ? undefined : comparisonParticipantFromRow(row);
  }

  public comparisonParticipants(comparisonRunId: string): ComparisonParticipant[] {
    const rows = this.database
      .prepare(
        `SELECT id, comparison_run_id, provider, model, status, provider_handle, response_text,
                input_tokens, output_tokens, latency_ms, failure_code, created_at, completed_at
         FROM comparison_participants WHERE comparison_run_id = ? ORDER BY created_at ASC, rowid ASC`,
      )
      .all(comparisonRunId) as unknown as ComparisonParticipantRow[];
    return rows.map(comparisonParticipantFromRow);
  }

  public recordComparisonInsights(participantId: string, payload: InsightPayload, createdAt = new Date().toISOString()): ComparisonInsight[] {
    const participant = this.comparisonParticipant(participantId);
    if (participant === undefined || participant.status !== 'succeeded') {
      throw new Error(`Comparison participant ${participantId} has no successful response.`);
    }
    const records: Array<{ kind: InsightKind; text: string; eventIds: string[] }> = [
      ...payload.findings.map((text) => ({ kind: 'finding' as const, text, eventIds: [] })),
      ...payload.evidence.map(({ text, eventIds }) => ({ kind: 'evidence' as const, text, eventIds })),
      ...payload.recommendations.map((text) => ({ kind: 'recommendation' as const, text, eventIds: [] })),
    ];
    return records.map(({ kind, text, eventIds }) => {
      const insight: ComparisonInsight = {
        id: randomUUID(),
        comparisonRunId: participant.comparisonRunId,
        participantId,
        kind,
        text: redactText(text, 'storage').value,
        eventIds,
        createdAt,
      };
      this.database
        .prepare(
          `INSERT INTO comparison_insights (
             id, comparison_run_id, participant_id, kind, text, event_ids_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(insight.id, insight.comparisonRunId, insight.participantId, insight.kind, insight.text, JSON.stringify(insight.eventIds), insight.createdAt);
      return insight;
    });
  }

  public comparisonInsights(comparisonRunId: string): ComparisonInsight[] {
    const rows = this.database
      .prepare(
        `SELECT id, comparison_run_id, participant_id, kind, text, event_ids_json, created_at
         FROM comparison_insights WHERE comparison_run_id = ? ORDER BY created_at ASC, rowid ASC`,
      )
      .all(comparisonRunId) as unknown as ComparisonInsightRow[];
    return rows.map(comparisonInsightFromRow);
  }

  public finalizeComparisonRun(id: string, completedAt = new Date().toISOString()): ComparisonRun {
    const run = this.comparisonRun(id);
    if (run === undefined) {
      throw new Error(`Comparison run ${id} does not exist.`);
    }
    if (run.status !== 'running') {
      return run;
    }
    const participants = this.comparisonParticipants(id);
    if (participants.length === 0 || participants.some(({ status }) => status === 'running')) {
      throw new Error(`Comparison run ${id} has unfinished participants.`);
    }
    const succeeded = participants.filter(({ status }) => status === 'succeeded').length;
    const status: ComparisonRun['status'] = succeeded === participants.length ? 'succeeded' : succeeded > 0 ? 'partial' : 'failed';
    this.database
      .prepare('UPDATE comparison_runs SET status = ?, completed_at = ? WHERE id = ?')
      .run(status, completedAt, id);
    return { ...run, status, completedAt };
  }

  /** Explicit copy creates a new logical branch at the source head without duplicating event history. */
  public copyBranch(sourceName: string, copiedName: string, createdAt = new Date().toISOString()): BranchCopy {
    const source = this.branch(sourceName);
    if (source === undefined) {
      throw new Error(`Branch ${sourceName} does not exist.`);
    }
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const copied = this.createBranch(copiedName, source.headRevisionId, source.persistence);
      const copy: BranchCopy = {
        id: randomUUID(),
        sourceBranchId: source.id,
        copiedBranchId: copied.id,
        revisionId: source.headRevisionId,
        createdAt,
      };
      this.database
        .prepare('INSERT INTO branch_copies (id, source_branch_id, copied_branch_id, revision_id, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(copy.id, copy.sourceBranchId, copy.copiedBranchId, copy.revisionId, copy.createdAt);
      this.database.exec('COMMIT');
      return copy;
    } catch (error: unknown) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  public copiesFromBranch(name: string): BranchCopy[] {
    const branch = this.branch(name);
    if (branch === undefined) {
      throw new Error(`Branch ${name} does not exist.`);
    }
    const rows = this.database
      .prepare(
        `SELECT id, source_branch_id, copied_branch_id, revision_id, created_at
         FROM branch_copies WHERE source_branch_id = ? ORDER BY created_at ASC, rowid ASC`,
      )
      .all(branch.id) as unknown as BranchCopyRow[];
    return rows.map(branchCopyFromRow);
  }

  /** Explicit merge may only fast-forward a same-session target; it never guesses a conflict resolution. */
  public mergeBranches(sourceName: string, targetName: string, createdAt = new Date().toISOString()): BranchMergeResult {
    const source = this.branch(sourceName);
    const target = this.branch(targetName);
    if (source === undefined || target === undefined) {
      throw new Error('Both source and target branches must exist.');
    }
    if (target.lifecycle !== 'open') {
      throw new Error(`Branch ${targetName} is closed.`);
    }
    const sourceRevision = this.revision(source.headRevisionId);
    const targetRevision = this.revision(target.headRevisionId);
    if (sourceRevision === undefined || targetRevision === undefined || sourceRevision.sessionId !== targetRevision.sessionId) {
      throw new Error('Cannot merge branches from different sessions without an explicit cross-session merge strategy.');
    }
    if (source.headRevisionId === target.headRevisionId) {
      return { targetBranchId: target.id, headRevisionId: target.headRevisionId, merged: false };
    }
    if (!this.isRevisionAncestor(target.headRevisionId, source.headRevisionId)) {
      throw new Error(`Cannot merge ${sourceName} into ${targetName}: target is not an ancestor of source.`);
    }
    const merge: BranchMerge = {
      id: randomUUID(),
      sourceBranchId: source.id,
      targetBranchId: target.id,
      fromRevisionId: target.headRevisionId,
      toRevisionId: source.headRevisionId,
      createdAt,
    };
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database
        .prepare('UPDATE branches SET head_revision_id = ?, tracking_revision_id = ? WHERE id = ?')
        .run(source.headRevisionId, source.headRevisionId, target.id);
      this.database
        .prepare(
          `INSERT INTO branch_merges (
             id, source_branch_id, target_branch_id, from_revision_id, to_revision_id, created_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(merge.id, merge.sourceBranchId, merge.targetBranchId, merge.fromRevisionId, merge.toRevisionId, merge.createdAt);
      this.database.exec('COMMIT');
    } catch (error: unknown) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return { targetBranchId: target.id, headRevisionId: source.headRevisionId, merged: true, merge };
  }

  public mergesIntoBranch(name: string): BranchMerge[] {
    const branch = this.branch(name);
    if (branch === undefined) {
      throw new Error(`Branch ${name} does not exist.`);
    }
    const rows = this.database
      .prepare(
        `SELECT id, source_branch_id, target_branch_id, from_revision_id, to_revision_id, created_at
         FROM branch_merges WHERE target_branch_id = ? ORDER BY created_at ASC, rowid ASC`,
      )
      .all(branch.id) as unknown as BranchMergeRow[];
    return rows.map(branchMergeFromRow);
  }

  /** Records an intentional, provider-independent continuation handoff. */
  public switchAgent(branchName: string, targetAgent: string, createdAt = new Date().toISOString()): AgentSwitch {
    if (targetAgent.trim().length === 0) {
      throw new Error('A target agent is required.');
    }
    const branch = this.branch(branchName);
    if (branch === undefined || branch.lifecycle !== 'open') {
      throw new Error(`Branch ${branchName} must be open to switch agents.`);
    }
    const switchRecord: AgentSwitch = {
      id: randomUUID(),
      branchId: branch.id,
      targetAgent,
      revisionId: branch.headRevisionId,
      createdAt,
    };
    this.database
      .prepare('INSERT INTO agent_switches (id, branch_id, target_agent, revision_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(switchRecord.id, switchRecord.branchId, switchRecord.targetAgent, switchRecord.revisionId, switchRecord.createdAt);
    return switchRecord;
  }

  public agentSwitches(name: string): AgentSwitch[] {
    const branch = this.branch(name);
    if (branch === undefined) {
      throw new Error(`Branch ${name} does not exist.`);
    }
    const rows = this.database
      .prepare(
        `SELECT id, branch_id, target_agent, revision_id, created_at
         FROM agent_switches WHERE branch_id = ? ORDER BY created_at ASC, rowid ASC`,
      )
      .all(branch.id) as unknown as AgentSwitchRow[];
    return rows.map(agentSwitchFromRow);
  }

  /** Stores lifecycle metadata only; the Git worktree is created by the write service first. */
  public createWriteWorktree(input: Omit<WriteWorktree, 'lifecycle' | 'closedAt'>): WriteWorktree {
    const branch = this.branchById(input.branchId);
    if (branch === undefined || branch.lifecycle !== 'open') {
      throw new Error('A write worktree requires an open Ghost branch.');
    }
    const existing = this.writeWorktreeForBranch(branch.name);
    if (existing !== undefined) {
      throw new Error(`Branch ${branch.name} already has a write worktree.`);
    }
    const worktree: WriteWorktree = { ...input, lifecycle: 'active' };
    this.database
      .prepare(
        `INSERT INTO write_worktrees (
           id, branch_id, repository_path, worktree_path, git_branch, base_commit, lifecycle, created_at, closed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        worktree.id,
        worktree.branchId,
        worktree.repositoryPath,
        worktree.worktreePath,
        worktree.gitBranch,
        worktree.baseCommit,
        worktree.lifecycle,
        worktree.createdAt,
      );
    return worktree;
  }

  public writeWorktreeForBranch(name: string): WriteWorktree | undefined {
    const branch = this.branch(name);
    if (branch === undefined) {
      return undefined;
    }
    const row = this.database
      .prepare(
        `SELECT id, branch_id, repository_path, worktree_path, git_branch, base_commit, lifecycle, created_at, closed_at
         FROM write_worktrees WHERE branch_id = ?`,
      )
      .get(branch.id) as WriteWorktreeRow | undefined;
    return row === undefined ? undefined : writeWorktreeFromRow(row);
  }

  public closeWriteWorktree(name: string, closedAt = new Date().toISOString()): WriteWorktree {
    const worktree = this.writeWorktreeForBranch(name);
    if (worktree === undefined) {
      throw new Error(`Branch ${name} has no write worktree.`);
    }
    if (worktree.lifecycle === 'closed') {
      return worktree;
    }
    this.database.prepare('UPDATE write_worktrees SET lifecycle = ?, closed_at = ? WHERE id = ?').run('closed', closedAt, worktree.id);
    return { ...worktree, lifecycle: 'closed', closedAt };
  }

  /** Stores a reproducible patch hash and commit range, never the patch contents. */
  public recordPatchProvenance(input: Omit<PatchProvenance, 'id'>): PatchProvenance {
    const worktree = this.writeWorktreeById(input.worktreeId);
    if (worktree === undefined) {
      throw new Error(`Write worktree ${input.worktreeId} does not exist.`);
    }
    if (worktree.baseCommit !== input.baseCommit) {
      throw new Error('Patch provenance must use the write worktree’s captured base commit.');
    }
    const existing = this.database
      .prepare(
        `SELECT id, worktree_id, base_commit, head_commit, diff_sha256, changed_file_count, created_at
         FROM patch_provenance WHERE worktree_id = ? AND head_commit = ?`,
      )
      .get(input.worktreeId, input.headCommit) as PatchProvenanceRow | undefined;
    if (existing !== undefined) {
      return patchProvenanceFromRow(existing);
    }
    const patch: PatchProvenance = { id: randomUUID(), ...input };
    this.database
      .prepare(
        `INSERT INTO patch_provenance (
           id, worktree_id, base_commit, head_commit, diff_sha256, changed_file_count, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(patch.id, patch.worktreeId, patch.baseCommit, patch.headCommit, patch.diffSha256, patch.changedFileCount, patch.createdAt);
    return patch;
  }

  public patchProvenanceForBranch(name: string): PatchProvenance[] {
    const worktree = this.writeWorktreeForBranch(name);
    if (worktree === undefined) {
      return [];
    }
    const rows = this.database
      .prepare(
        `SELECT id, worktree_id, base_commit, head_commit, diff_sha256, changed_file_count, created_at
         FROM patch_provenance WHERE worktree_id = ? ORDER BY created_at ASC, rowid ASC`,
      )
      .all(worktree.id) as unknown as PatchProvenanceRow[];
    return rows.map(patchProvenanceFromRow);
  }

  /** Records only a completed fast-forward. Calling code must require explicit user approval before Git mutation. */
  public recordWritePromotion(input: Omit<WritePromotion, 'id' | 'status' | 'failureCode' | 'completedAt' | 'targetAfterCommit'> & { targetAfterCommit: string }): WritePromotion {
    const worktree = this.writeWorktreeById(input.worktreeId);
    if (worktree === undefined) {
      throw new Error(`Write worktree ${input.worktreeId} does not exist.`);
    }
    const patch = this.database
      .prepare('SELECT id FROM patch_provenance WHERE id = ? AND worktree_id = ?')
      .get(input.patchId, input.worktreeId) as { id: string } | undefined;
    if (patch === undefined) {
      throw new Error('Write promotion must reference patch provenance from the same worktree.');
    }
    const promotion: WritePromotion = { id: randomUUID(), ...input, status: 'succeeded', completedAt: input.createdAt };
    this.database
      .prepare(
        `INSERT INTO write_promotions (
           id, worktree_id, patch_id, target_git_branch, source_commit, target_before_commit, target_after_commit, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        promotion.id,
        promotion.worktreeId,
        promotion.patchId,
        promotion.targetGitBranch,
        promotion.sourceCommit,
        promotion.targetBeforeCommit,
        input.targetAfterCommit,
        promotion.createdAt,
      );
    return promotion;
  }

  public writePromotionsForBranch(name: string): WritePromotion[] {
    const worktree = this.writeWorktreeForBranch(name);
    if (worktree === undefined) {
      return [];
    }
    const rows = this.database
      .prepare(
        `SELECT id, worktree_id, patch_id, target_git_branch, source_commit, target_before_commit, target_after_commit, created_at
         FROM write_promotions WHERE worktree_id = ? ORDER BY created_at ASC, rowid ASC`,
      )
      .all(worktree.id) as unknown as WritePromotionRow[];
    return rows.map(writePromotionFromRow);
  }

  public startMaterializationRun(input: StartMaterializationRun): MaterializationRun {
    const branch = this.branchById(input.branchId);
    if (branch === undefined) {
      throw new Error(`Branch ${input.branchId} does not exist.`);
    }
    if (branch.lifecycle !== 'open') {
      throw new Error(`Branch ${branch.name} is closed.`);
    }
    if (!this.isRevisionAncestor(input.sourceRevisionId, branch.headRevisionId)) {
      throw new Error(`Revision ${input.sourceRevisionId} is not reachable from branch ${branch.name}.`);
    }
    const run: MaterializationRun = {
      id: randomUUID(),
      ...input,
      status: 'running',
      recovery: 'Ghost retains the source revision; retrying does not require provider session state.',
    };
    this.database
      .prepare(
        `INSERT INTO materialization_runs (
           id, branch_id, provider, model, source_revision_id, mode, strategy, status, materialization_id,
           provider_handle, input_tokens, output_tokens, estimated_cost_usd, latency_ms, response_text, recovery, failure_code, created_at,
           completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL, ?, NULL)`,
      )
      .run(
        run.id,
        run.branchId,
        run.provider,
        run.model,
        run.sourceRevisionId,
        run.mode,
        run.strategy,
        run.status,
        run.recovery,
        run.createdAt,
      );
    return run;
  }

  public completeMaterializationRun(id: string, outcome: CompleteMaterializationRun): MaterializationRun {
    const run = this.materializationRun(id);
    if (run === undefined) {
      throw new Error(`Materialization run ${id} does not exist.`);
    }
    if (run.status !== 'running') {
      throw new Error(`Materialization run ${id} is already ${run.status}.`);
    }
    this.database
      .prepare(
        `UPDATE materialization_runs
         SET status = ?, materialization_id = ?, provider_handle = ?, input_tokens = ?, output_tokens = ?,
             estimated_cost_usd = ?, latency_ms = ?, response_text = ?, completed_at = ?
         WHERE id = ?`,
      )
      .run(
        'succeeded',
        outcome.materializationId,
        outcome.providerHandle ?? null,
        outcome.inputTokens ?? null,
        outcome.outputTokens ?? null,
        outcome.estimatedCostUsd ?? null,
        outcome.latencyMs,
        outcome.responseText,
        outcome.completedAt,
        id,
      );
    return {
      ...run,
      status: 'succeeded',
      materializationId: outcome.materializationId,
      ...(outcome.providerHandle === undefined ? {} : { providerHandle: outcome.providerHandle }),
      ...(outcome.inputTokens === undefined ? {} : { inputTokens: outcome.inputTokens }),
      ...(outcome.outputTokens === undefined ? {} : { outputTokens: outcome.outputTokens }),
      ...(outcome.estimatedCostUsd === undefined ? {} : { estimatedCostUsd: outcome.estimatedCostUsd }),
      latencyMs: outcome.latencyMs,
      responseText: outcome.responseText,
      completedAt: outcome.completedAt,
    };
  }

  public failMaterializationRun(id: string, failureCode: string, completedAt: string, latencyMs?: number): MaterializationRun {
    const run = this.materializationRun(id);
    if (run === undefined) {
      throw new Error(`Materialization run ${id} does not exist.`);
    }
    if (run.status !== 'running') {
      throw new Error(`Materialization run ${id} is already ${run.status}.`);
    }
    const recovery = 'Ghost retained the source revision and workspace snapshot; retry the same ask when the provider is available.';
    this.database
      .prepare('UPDATE materialization_runs SET status = ?, recovery = ?, failure_code = ?, latency_ms = ?, completed_at = ? WHERE id = ?')
      .run('failed', recovery, failureCode, latencyMs ?? null, completedAt, id);
    return { ...run, status: 'failed', recovery, failureCode, ...(latencyMs === undefined ? {} : { latencyMs }), completedAt };
  }

  public materializationRun(id: string): MaterializationRun | undefined {
    const row = this.database
      .prepare(
        `SELECT id, branch_id, provider, model, source_revision_id, mode, strategy, status, materialization_id,
                provider_handle, input_tokens, output_tokens, estimated_cost_usd, latency_ms, response_text, recovery, failure_code, created_at,
                completed_at
         FROM materialization_runs WHERE id = ?`,
      )
      .get(id) as MaterializationRunRow | undefined;
    return row === undefined ? undefined : materializationRunFromRow(row);
  }

  public latestMaterializationRun(branchName: string): MaterializationRun | undefined {
    const branch = this.branch(branchName);
    if (branch === undefined) {
      return undefined;
    }
    const row = this.database
      .prepare(
        `SELECT id, branch_id, provider, model, source_revision_id, mode, strategy, status, materialization_id,
                provider_handle, input_tokens, output_tokens, estimated_cost_usd, latency_ms, response_text, recovery, failure_code, created_at,
                completed_at
         FROM materialization_runs WHERE branch_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(branch.id) as MaterializationRunRow | undefined;
    return row === undefined ? undefined : materializationRunFromRow(row);
  }

  /** Returns true when the first revision is equal to or an ancestor of the second revision. */
  public isRevisionAncestor(ancestorRevisionId: string, descendantRevisionId: string): boolean {
    const row = this.database
      .prepare(
        `WITH RECURSIVE lineage(id, parent_revision_id) AS (
           SELECT id, parent_revision_id FROM revisions WHERE id = ?
           UNION ALL
           SELECT revisions.id, revisions.parent_revision_id
           FROM revisions JOIN lineage ON revisions.id = lineage.parent_revision_id
         )
         SELECT EXISTS(SELECT 1 FROM lineage WHERE id = ?) AS is_ancestor`,
      )
      .get(descendantRevisionId, ancestorRevisionId) as { is_ancestor: number };
    return row.is_ancestor === 1;
  }

  private branchById(id: string): GhostBranch | undefined {
    const row = this.database
      .prepare(
        `SELECT id, name, persistence, lifecycle, base_revision_id, head_revision_id, tracking_revision_id,
                originating_session_id, created_at, closed_at
         FROM branches WHERE id = ?`,
      )
      .get(id) as BranchRow | undefined;
    return row === undefined ? undefined : this.branchFromRow(row);
  }

  private canonicalSessionId(event: GhostEvent): string {
    const legacy = this.database
      .prepare('SELECT id FROM sessions WHERE id = ? AND source = ? AND source_session_id = ? AND cwd = ?')
      .get(event.sessionId, event.source, event.sessionId, event.workspace.cwd) as SessionIdRow | undefined;
    if (legacy !== undefined) {
      return legacy.id;
    }
    return createHash('sha256')
      .update(event.source)
      .update('\0')
      .update(event.sessionId)
      .update('\0')
      .update(event.workspace.cwd)
      .digest('hex');
  }

  private resolveStoredSessionId(sessionId: string): string {
    const exact = this.database.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId) as SessionIdRow | undefined;
    if (exact !== undefined) return exact.id;
    const rows = this.database
      .prepare('SELECT id FROM sessions WHERE source_session_id = ? ORDER BY last_seen_at DESC, rowid DESC')
      .all(sessionId) as unknown as SessionIdRow[];
    if (rows.length === 0) return sessionId;
    const [row] = rows;
    if (rows.length === 1 && row !== undefined) return row.id;
    throw new Error(`Provider session ID ${sessionId} is ambiguous; use ghost session list and select the canonical Ghost session ID.`);
  }

  private sourceSessionId(storedSessionId: string): string {
    const row = this.database
      .prepare('SELECT source_session_id FROM sessions WHERE id = ?')
      .get(storedSessionId) as { source_session_id: string } | undefined;
    return row?.source_session_id ?? storedSessionId;
  }

  private branchFromRow(row: BranchRow): GhostBranch {
    const branch = branchFromRow(row);
    return { ...branch, originatingSessionId: this.sourceSessionId(branch.originatingSessionId) };
  }

  private writeWorktreeById(id: string): WriteWorktree | undefined {
    const row = this.database
      .prepare(
        `SELECT id, branch_id, repository_path, worktree_path, git_branch, base_commit, lifecycle, created_at, closed_at
         FROM write_worktrees WHERE id = ?`,
      )
      .get(id) as WriteWorktreeRow | undefined;
    return row === undefined ? undefined : writeWorktreeFromRow(row);
  }

  private latestRevisionForBranch(branch: GhostBranch): GhostRevision {
    return this.createRevision(branch.originatingSessionId);
  }

  private branchMaterializations(branchId: string): BranchMaterialization[] {
    const rows = this.database
      .prepare(
        `SELECT id, branch_id, provider, provider_handle, synchronized_revision_id, created_at, updated_at
         FROM branch_materializations WHERE branch_id = ?`,
      )
      .all(branchId) as unknown as MaterializationRow[];
    return rows.map(materializationFromRow);
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        source_session_id TEXT NOT NULL,
        cwd TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        ended_at TEXT
      );

      CREATE TABLE IF NOT EXISTS active_session_selections (
        workspace_cwd TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
        selected_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        sequence INTEGER NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 1,
        timestamp TEXT NOT NULL,
        source TEXT NOT NULL,
        type TEXT NOT NULL,
        trust_class TEXT,
        payload_json TEXT NOT NULL,
        workspace_cwd TEXT NOT NULL,
        git_head TEXT,
        git_status TEXT,
        UNIQUE(session_id, sequence)
      );

      CREATE INDEX IF NOT EXISTS events_session_sequence
      ON events(session_id, sequence);

      CREATE TABLE IF NOT EXISTS workspace_snapshots (
        id TEXT PRIMARY KEY,
        cwd TEXT NOT NULL,
        git_head TEXT,
        git_status TEXT
      );

      CREATE TABLE IF NOT EXISTS revisions (
        id TEXT PRIMARY KEY,
        parent_revision_id TEXT REFERENCES revisions(id) ON DELETE RESTRICT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
        event_high_water_mark INTEGER NOT NULL,
        workspace_snapshot_id TEXT NOT NULL REFERENCES workspace_snapshots(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL,
        UNIQUE(session_id, event_high_water_mark)
      );

      CREATE INDEX IF NOT EXISTS revisions_session_high_water
      ON revisions(session_id, event_high_water_mark);

      CREATE TABLE IF NOT EXISTS branches (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        persistence TEXT NOT NULL CHECK (persistence IN ('persistent', 'ephemeral')),
        lifecycle TEXT NOT NULL CHECK (lifecycle IN ('open', 'closed')),
        base_revision_id TEXT NOT NULL REFERENCES revisions(id) ON DELETE RESTRICT,
        head_revision_id TEXT NOT NULL REFERENCES revisions(id) ON DELETE RESTRICT,
        tracking_revision_id TEXT NOT NULL REFERENCES revisions(id) ON DELETE RESTRICT,
        originating_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL,
        closed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS branch_materializations (
        id TEXT PRIMARY KEY,
        branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
        provider TEXT NOT NULL,
        provider_handle TEXT,
        synchronized_revision_id TEXT NOT NULL REFERENCES revisions(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS branch_materializations_branch_created
      ON branch_materializations(branch_id, created_at);

      CREATE TABLE IF NOT EXISTS branch_rebases (
        id TEXT PRIMARY KEY,
        branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
        from_revision_id TEXT NOT NULL REFERENCES revisions(id) ON DELETE RESTRICT,
        to_revision_id TEXT NOT NULL REFERENCES revisions(id) ON DELETE RESTRICT,
        added_event_count INTEGER NOT NULL CHECK (added_event_count >= 0),
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS branch_rebases_branch_created
      ON branch_rebases(branch_id, created_at);

      CREATE TABLE IF NOT EXISTS comparison_runs (
        id TEXT PRIMARY KEY,
        branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
        frozen_revision_id TEXT NOT NULL REFERENCES revisions(id) ON DELETE RESTRICT,
        workspace_snapshot_id TEXT NOT NULL REFERENCES workspace_snapshots(id) ON DELETE RESTRICT,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'partial', 'failed')),
        created_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS comparison_runs_branch_created
      ON comparison_runs(branch_id, created_at);

      CREATE TABLE IF NOT EXISTS comparison_participants (
        id TEXT PRIMARY KEY,
        comparison_run_id TEXT NOT NULL REFERENCES comparison_runs(id) ON DELETE RESTRICT,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
        provider_handle TEXT,
        response_text TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        latency_ms INTEGER,
        failure_code TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS comparison_participants_run_created
      ON comparison_participants(comparison_run_id, created_at);

      CREATE TABLE IF NOT EXISTS comparison_insights (
        id TEXT PRIMARY KEY,
        comparison_run_id TEXT NOT NULL REFERENCES comparison_runs(id) ON DELETE RESTRICT,
        participant_id TEXT NOT NULL REFERENCES comparison_participants(id) ON DELETE RESTRICT,
        kind TEXT NOT NULL CHECK (kind IN ('finding', 'evidence', 'recommendation')),
        text TEXT NOT NULL,
        event_ids_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS comparison_insights_run_kind
      ON comparison_insights(comparison_run_id, kind, created_at);

      CREATE TABLE IF NOT EXISTS branch_copies (
        id TEXT PRIMARY KEY,
        source_branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
        copied_branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
        revision_id TEXT NOT NULL REFERENCES revisions(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS branch_copies_source_created
      ON branch_copies(source_branch_id, created_at);

      CREATE TABLE IF NOT EXISTS branch_merges (
        id TEXT PRIMARY KEY,
        source_branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
        target_branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
        from_revision_id TEXT NOT NULL REFERENCES revisions(id) ON DELETE RESTRICT,
        to_revision_id TEXT NOT NULL REFERENCES revisions(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS branch_merges_target_created
      ON branch_merges(target_branch_id, created_at);

      CREATE TABLE IF NOT EXISTS agent_switches (
        id TEXT PRIMARY KEY,
        branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
        target_agent TEXT NOT NULL,
        revision_id TEXT NOT NULL REFERENCES revisions(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS agent_switches_branch_created
      ON agent_switches(branch_id, created_at);

      CREATE TABLE IF NOT EXISTS write_worktrees (
        id TEXT PRIMARY KEY,
        branch_id TEXT NOT NULL UNIQUE REFERENCES branches(id) ON DELETE RESTRICT,
        repository_path TEXT NOT NULL,
        worktree_path TEXT NOT NULL UNIQUE,
        git_branch TEXT NOT NULL UNIQUE,
        base_commit TEXT NOT NULL,
        lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'closed')),
        created_at TEXT NOT NULL,
        closed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS write_worktrees_repository_lifecycle
      ON write_worktrees(repository_path, lifecycle);

      CREATE TABLE IF NOT EXISTS patch_provenance (
        id TEXT PRIMARY KEY,
        worktree_id TEXT NOT NULL REFERENCES write_worktrees(id) ON DELETE RESTRICT,
        base_commit TEXT NOT NULL,
        head_commit TEXT NOT NULL,
        diff_sha256 TEXT NOT NULL,
        changed_file_count INTEGER NOT NULL CHECK (changed_file_count > 0),
        created_at TEXT NOT NULL,
        UNIQUE(worktree_id, head_commit)
      );

      CREATE INDEX IF NOT EXISTS patch_provenance_worktree_created
      ON patch_provenance(worktree_id, created_at);

      CREATE TABLE IF NOT EXISTS write_promotions (
        id TEXT PRIMARY KEY,
        worktree_id TEXT NOT NULL REFERENCES write_worktrees(id) ON DELETE RESTRICT,
        patch_id TEXT NOT NULL REFERENCES patch_provenance(id) ON DELETE RESTRICT,
        target_git_branch TEXT NOT NULL,
        source_commit TEXT NOT NULL,
        target_before_commit TEXT NOT NULL,
        target_after_commit TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS write_promotions_worktree_created
      ON write_promotions(worktree_id, created_at);

      CREATE TABLE IF NOT EXISTS materialization_runs (
        id TEXT PRIMARY KEY,
        branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        source_revision_id TEXT NOT NULL REFERENCES revisions(id) ON DELETE RESTRICT,
        mode TEXT NOT NULL CHECK (mode IN ('ephemeral', 'persistent')),
        strategy TEXT NOT NULL CHECK (strategy IN ('native_fork', 'session_resume', 'context_replay')),
        status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
        materialization_id TEXT REFERENCES branch_materializations(id) ON DELETE RESTRICT,
        provider_handle TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        estimated_cost_usd REAL,
        latency_ms INTEGER,
        response_text TEXT,
        recovery TEXT NOT NULL,
        failure_code TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS materialization_runs_branch_created
      ON materialization_runs(branch_id, created_at);
    `);

    const eventColumns = this.database.prepare('PRAGMA table_info(events)').all() as unknown as ColumnRow[];
    if (!eventColumns.some(({ name }) => name === 'schema_version')) {
      this.database.exec('ALTER TABLE events ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1');
    }
    if (!eventColumns.some(({ name }) => name === 'trust_class')) {
      this.database.exec('ALTER TABLE events ADD COLUMN trust_class TEXT');
    }
    const sessionColumns = this.database.prepare('PRAGMA table_info(sessions)').all() as unknown as ColumnRow[];
    if (!sessionColumns.some(({ name }) => name === 'ended_at')) {
      this.database.exec('ALTER TABLE sessions ADD COLUMN ended_at TEXT');
    }
    const materializationRunColumns = this.database.prepare('PRAGMA table_info(materialization_runs)').all() as unknown as ColumnRow[];
    if (!materializationRunColumns.some(({ name }) => name === 'response_text')) {
      this.database.exec('ALTER TABLE materialization_runs ADD COLUMN response_text TEXT');
    }
    if (!materializationRunColumns.some(({ name }) => name === 'latency_ms')) {
      this.database.exec('ALTER TABLE materialization_runs ADD COLUMN latency_ms INTEGER');
    }
  }
}

function snapshotFromCheckpoint(checkpoint: EventCheckpointRow): WorkspaceSnapshot {
  const json = JSON.stringify({
    cwd: checkpoint.workspace_cwd,
    gitHead: checkpoint.git_head,
    gitStatus: checkpoint.git_status,
  });
  return {
    id: createHash('sha256').update(json).digest('hex'),
    cwd: checkpoint.workspace_cwd,
    ...(checkpoint.git_head === null ? {} : { gitHead: checkpoint.git_head }),
    ...(checkpoint.git_status === null ? {} : { gitStatus: checkpoint.git_status }),
  };
}

function capturedSessionFromRow(row: SessionRow): CapturedSession {
  return {
    id: row.id,
    source: row.source,
    sourceSessionId: row.source_session_id,
    workspaceCwd: row.cwd,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
  };
}

function revisionFromRow(row: RevisionRow): GhostRevision {
  return {
    id: row.id,
    ...(row.parent_revision_id === null ? {} : { parentRevisionId: row.parent_revision_id }),
    sessionId: row.session_id,
    eventHighWaterMark: row.event_high_water_mark,
    workspaceSnapshotId: row.workspace_snapshot_id,
    createdAt: row.created_at,
  };
}

function workspaceSnapshotFromRow(row: WorkspaceSnapshotRow): WorkspaceSnapshot {
  return {
    id: row.id,
    cwd: row.cwd,
    ...(row.git_head === null ? {} : { gitHead: row.git_head }),
    ...(row.git_status === null ? {} : { gitStatus: row.git_status }),
  };
}

function branchFromRow(row: BranchRow): GhostBranch {
  return {
    id: row.id,
    name: row.name,
    persistence: row.persistence,
    lifecycle: row.lifecycle,
    baseRevisionId: row.base_revision_id,
    headRevisionId: row.head_revision_id,
    trackingRevisionId: row.tracking_revision_id,
    originatingSessionId: row.originating_session_id,
    createdAt: row.created_at,
    ...(row.closed_at === null ? {} : { closedAt: row.closed_at }),
  };
}

function materializationFromRow(row: MaterializationRow): BranchMaterialization {
  return {
    id: row.id,
    branchId: row.branch_id,
    provider: row.provider,
    ...(row.provider_handle === null ? {} : { providerHandle: row.provider_handle }),
    synchronizedRevisionId: row.synchronized_revision_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function branchRebaseFromRow(row: BranchRebaseRow): BranchRebase {
  return {
    id: row.id,
    branchId: row.branch_id,
    fromRevisionId: row.from_revision_id,
    toRevisionId: row.to_revision_id,
    addedEventCount: row.added_event_count,
    createdAt: row.created_at,
  };
}

function writeWorktreeFromRow(row: WriteWorktreeRow): WriteWorktree {
  return {
    id: row.id,
    branchId: row.branch_id,
    repositoryPath: row.repository_path,
    worktreePath: row.worktree_path,
    gitBranch: row.git_branch,
    baseCommit: row.base_commit,
    lifecycle: row.lifecycle,
    createdAt: row.created_at,
    ...(row.closed_at === null ? {} : { closedAt: row.closed_at }),
  };
}

function patchProvenanceFromRow(row: PatchProvenanceRow): PatchProvenance {
  return {
    id: row.id,
    worktreeId: row.worktree_id,
    baseCommit: row.base_commit,
    headCommit: row.head_commit,
    diffSha256: row.diff_sha256,
    changedFileCount: row.changed_file_count,
    createdAt: row.created_at,
  };
}

function writePromotionFromRow(row: WritePromotionRow): WritePromotion {
  return {
    id: row.id,
    worktreeId: row.worktree_id,
    patchId: row.patch_id,
    targetGitBranch: row.target_git_branch,
    sourceCommit: row.source_commit,
    targetBeforeCommit: row.target_before_commit,
    targetAfterCommit: row.target_after_commit,
    status: 'succeeded',
    createdAt: row.created_at,
    completedAt: row.created_at,
  };
}

function comparisonRunFromRow(row: ComparisonRunRow): ComparisonRun {
  return {
    id: row.id,
    branchId: row.branch_id,
    frozenRevisionId: row.frozen_revision_id,
    workspaceSnapshotId: row.workspace_snapshot_id,
    prompt: row.prompt,
    status: row.status,
    createdAt: row.created_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
  };
}

function comparisonParticipantFromRow(row: ComparisonParticipantRow): ComparisonParticipant {
  return {
    id: row.id,
    comparisonRunId: row.comparison_run_id,
    provider: row.provider,
    model: row.model,
    status: row.status,
    ...(row.provider_handle === null ? {} : { providerHandle: row.provider_handle }),
    ...(row.response_text === null ? {} : { responseText: row.response_text }),
    ...(row.input_tokens === null ? {} : { inputTokens: row.input_tokens }),
    ...(row.output_tokens === null ? {} : { outputTokens: row.output_tokens }),
    ...(row.latency_ms === null ? {} : { latencyMs: row.latency_ms }),
    ...(row.failure_code === null ? {} : { failureCode: row.failure_code }),
    createdAt: row.created_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
  };
}

function comparisonInsightFromRow(row: ComparisonInsightRow): ComparisonInsight {
  const eventIds = JSON.parse(row.event_ids_json) as unknown;
  return {
    id: row.id,
    comparisonRunId: row.comparison_run_id,
    participantId: row.participant_id,
    kind: row.kind,
    text: row.text,
    eventIds: Array.isArray(eventIds) && eventIds.every((value) => typeof value === 'string') ? eventIds : [],
    createdAt: row.created_at,
  };
}

function branchCopyFromRow(row: BranchCopyRow): BranchCopy {
  return {
    id: row.id,
    sourceBranchId: row.source_branch_id,
    copiedBranchId: row.copied_branch_id,
    revisionId: row.revision_id,
    createdAt: row.created_at,
  };
}

function branchMergeFromRow(row: BranchMergeRow): BranchMerge {
  return {
    id: row.id,
    sourceBranchId: row.source_branch_id,
    targetBranchId: row.target_branch_id,
    fromRevisionId: row.from_revision_id,
    toRevisionId: row.to_revision_id,
    createdAt: row.created_at,
  };
}

function agentSwitchFromRow(row: AgentSwitchRow): AgentSwitch {
  return {
    id: row.id,
    branchId: row.branch_id,
    targetAgent: row.target_agent,
    revisionId: row.revision_id,
    createdAt: row.created_at,
  };
}

function materializationRunFromRow(row: MaterializationRunRow): MaterializationRun {
  return {
    id: row.id,
    branchId: row.branch_id,
    provider: row.provider,
    model: row.model,
    sourceRevisionId: row.source_revision_id,
    mode: row.mode,
    strategy: row.strategy,
    status: row.status,
    ...(row.materialization_id === null ? {} : { materializationId: row.materialization_id }),
    ...(row.provider_handle === null ? {} : { providerHandle: row.provider_handle }),
    ...(row.input_tokens === null ? {} : { inputTokens: row.input_tokens }),
    ...(row.output_tokens === null ? {} : { outputTokens: row.output_tokens }),
    ...(row.estimated_cost_usd === null ? {} : { estimatedCostUsd: row.estimated_cost_usd }),
    ...(row.latency_ms === null ? {} : { latencyMs: row.latency_ms }),
    ...(row.response_text === null ? {} : { responseText: row.response_text }),
    recovery: row.recovery,
    ...(row.failure_code === null ? {} : { failureCode: row.failure_code }),
    createdAt: row.created_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
  };
}
