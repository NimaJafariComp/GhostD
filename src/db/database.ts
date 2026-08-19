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
import { redactEvent } from '../privacy/redaction.js';

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

interface SessionRow {
  id: string;
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
      .get(storedEvent.id) as SessionRow | undefined;
    if (existing !== undefined) {
      throw new Error(`Event ${storedEvent.id} already exists; events are append-only.`);
    }

    this.database.exec('BEGIN IMMEDIATE');
    try {
      const now = storedEvent.timestamp;
      this.database
        .prepare(
          `INSERT INTO sessions (id, source, source_session_id, cwd, created_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at, cwd = excluded.cwd`,
        )
        .run(storedEvent.sessionId, storedEvent.source, storedEvent.sessionId, storedEvent.workspace.cwd, now, now);

      const next = this.database
        .prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM events WHERE session_id = ?')
        .get(storedEvent.sessionId) as { sequence: number };

      this.database
        .prepare(
          `INSERT INTO events (
             id, session_id, sequence, schema_version, timestamp, source, type, trust_class, payload_json,
             workspace_cwd, git_head, git_status
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          storedEvent.id,
          storedEvent.sessionId,
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
      .prepare('SELECT id FROM sessions ORDER BY last_seen_at DESC LIMIT 1')
      .get() as SessionRow | undefined;
    return row?.id;
  }

  public eventsForSession(sessionId: string): StoredEvent[] {
    return this.eventsForSessionThrough(sessionId);
  }

  public eventsForSessionThrough(sessionId: string, eventHighWaterMark?: number): StoredEvent[] {
    const rows = this.database
      .prepare(
        `SELECT id, session_id, sequence, schema_version, timestamp, source, type, trust_class, payload_json,
                workspace_cwd, git_head, git_status
         FROM events
         WHERE session_id = ? ${eventHighWaterMark === undefined ? '' : 'AND sequence <= ?'}
         ORDER BY sequence ASC`,
      )
      .all(...(eventHighWaterMark === undefined ? [sessionId] : [sessionId, eventHighWaterMark])) as unknown as EventRow[];

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
        .get(sessionId, checkpoint.sequence) as SessionRow | undefined;
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
    return branch;
  }

  public branch(name: string): GhostBranch | undefined {
    const row = this.database
      .prepare(
        `SELECT id, name, persistence, lifecycle, base_revision_id, head_revision_id, tracking_revision_id,
                originating_session_id, created_at, closed_at
         FROM branches WHERE name = ?`,
      )
      .get(name) as BranchRow | undefined;
    return row === undefined ? undefined : branchFromRow(row);
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
    return row === undefined ? undefined : branchFromRow(row);
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
        last_seen_at TEXT NOT NULL
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
