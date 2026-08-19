import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { deriveTrustClass } from '../core/events.js';
import type { GhostEvent } from '../core/events.js';
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
    const rows = this.database
      .prepare(
        `SELECT id, session_id, sequence, schema_version, timestamp, source, type, trust_class, payload_json,
                workspace_cwd, git_head, git_status
         FROM events
         WHERE session_id = ?
         ORDER BY sequence ASC`,
      )
      .all(sessionId) as unknown as EventRow[];

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
    `);

    const eventColumns = this.database.prepare('PRAGMA table_info(events)').all() as unknown as ColumnRow[];
    if (!eventColumns.some(({ name }) => name === 'schema_version')) {
      this.database.exec('ALTER TABLE events ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1');
    }
    if (!eventColumns.some(({ name }) => name === 'trust_class')) {
      this.database.exec('ALTER TABLE events ADD COLUMN trust_class TEXT');
    }
  }
}
