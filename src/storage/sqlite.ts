/**
 * SQLite-backed persistent storage for events, routines, and tokens.
 *
 * Uses a single .sqlite file on disk so everything survives restarts.
 * No external services needed — just a file path.
 */

import Database from 'better-sqlite3';
import type { EventStore, StoredEvent, EventQuery, EventQueryResult } from '../events/event-store';
import type { RoutineStore, StoredRoutine } from '../routines/routine-store';
import type { TokenStore, TokenPair } from '../auth/token-store';

export class SqliteStorage {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        event_type TEXT NOT NULL,
        namespace TEXT NOT NULL,
        endpoint_id TEXT,
        user_id TEXT,
        cause TEXT,
        payload TEXT NOT NULL DEFAULT '{}',
        tags TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_events_endpoint ON events(endpoint_id);
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
      CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id);

      CREATE TABLE IF NOT EXISTS routines (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        trigger_def TEXT NOT NULL,
        actions TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_triggered TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tokens (
        user_id TEXT PRIMARY KEY,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
  }

  events(): SqliteEventStore {
    return new SqliteEventStore(this.db);
  }

  routines(): SqliteRoutineStore {
    return new SqliteRoutineStore(this.db);
  }

  tokens(): SqliteTokenStore {
    return new SqliteTokenStore(this.db);
  }

  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Event store
// ---------------------------------------------------------------------------

export class SqliteEventStore implements EventStore {
  constructor(private db: Database.Database) {}

  async insert(event: StoredEvent): Promise<void> {
    this.db.prepare(`
      INSERT INTO events (id, timestamp, event_type, namespace, endpoint_id, user_id, cause, payload, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.timestamp,
      event.eventType,
      event.namespace,
      event.endpointId ?? null,
      event.userId ?? null,
      event.cause ?? null,
      JSON.stringify(event.payload),
      JSON.stringify(event.tags ?? []),
    );
  }

  async insertBatch(events: StoredEvent[]): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO events (id, timestamp, event_type, namespace, endpoint_id, user_id, cause, payload, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = this.db.transaction((evts: StoredEvent[]) => {
      for (const e of evts) {
        stmt.run(e.id, e.timestamp, e.eventType, e.namespace,
          e.endpointId ?? null, e.userId ?? null, e.cause ?? null,
          JSON.stringify(e.payload), JSON.stringify(e.tags ?? []));
      }
    });
    tx(events);
  }

  async query(query: EventQuery): Promise<EventQueryResult> {
    const { where, params } = this.buildWhere(query);

    const countRow = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM events ${where}`
    ).get(...params) as { cnt: number };
    const totalCount = countRow.cnt;

    let sql = `SELECT * FROM events ${where} ORDER BY timestamp DESC`;

    if (query.cursor) {
      const cursorRow = this.db.prepare(
        'SELECT timestamp FROM events WHERE id = ?'
      ).get(query.cursor) as { timestamp: string } | undefined;
      if (cursorRow) {
        sql = `SELECT * FROM events ${where ? where + ' AND' : 'WHERE'} (timestamp < ? OR (timestamp = ? AND id < ?)) ORDER BY timestamp DESC`;
        params.push(cursorRow.timestamp, cursorRow.timestamp, query.cursor);
      }
    }

    const limit = query.limit ?? 100;
    sql += ` LIMIT ?`;
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as any[];
    const events = rows.map(rowToEvent);
    const cursor = events.length === limit ? events[events.length - 1].id : undefined;

    return { events, totalCount, cursor };
  }

  async getById(id: string): Promise<StoredEvent | null> {
    const row = this.db.prepare('SELECT * FROM events WHERE id = ?').get(id) as any;
    return row ? rowToEvent(row) : null;
  }

  async count(query?: Partial<EventQuery>): Promise<number> {
    if (!query) {
      const row = this.db.prepare('SELECT COUNT(*) as cnt FROM events').get() as { cnt: number };
      return row.cnt;
    }
    const { where, params } = this.buildWhere(query as EventQuery);
    const row = this.db.prepare(`SELECT COUNT(*) as cnt FROM events ${where}`).get(...params) as { cnt: number };
    return row.cnt;
  }

  async prune(olderThan: string): Promise<number> {
    const result = this.db.prepare('DELETE FROM events WHERE timestamp < ?').run(olderThan);
    return result.changes;
  }

  private buildWhere(query: EventQuery): { where: string; params: any[] } {
    const conditions: string[] = [];
    const params: any[] = [];

    if (query.endpointId) { conditions.push('endpoint_id = ?'); params.push(query.endpointId); }
    if (query.userId) { conditions.push('user_id = ?'); params.push(query.userId); }
    if (query.eventType) { conditions.push('event_type = ?'); params.push(query.eventType); }
    if (query.namespace) { conditions.push('namespace = ?'); params.push(query.namespace); }
    if (query.startTime) { conditions.push('timestamp >= ?'); params.push(query.startTime); }
    if (query.endTime) { conditions.push('timestamp <= ?'); params.push(query.endTime); }
    if (query.tags && query.tags.length > 0) {
      for (const tag of query.tags) {
        conditions.push("tags LIKE ?");
        params.push(`%"${tag}"%`);
      }
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    return { where, params };
  }
}

function rowToEvent(row: any): StoredEvent {
  return {
    id: row.id,
    timestamp: row.timestamp,
    eventType: row.event_type,
    namespace: row.namespace,
    endpointId: row.endpoint_id ?? undefined,
    userId: row.user_id ?? undefined,
    cause: row.cause ?? undefined,
    payload: JSON.parse(row.payload),
    tags: JSON.parse(row.tags),
  };
}

// ---------------------------------------------------------------------------
// Routine store
// ---------------------------------------------------------------------------

export class SqliteRoutineStore implements RoutineStore {
  constructor(private db: Database.Database) {}

  async create(routine: StoredRoutine): Promise<void> {
    this.db.prepare(`
      INSERT INTO routines (id, name, trigger_def, actions, enabled, last_triggered, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      routine.id, routine.name,
      JSON.stringify(routine.trigger), JSON.stringify(routine.actions),
      routine.enabled ? 1 : 0, routine.lastTriggered ?? null, routine.createdAt,
    );
  }

  async get(routineId: string): Promise<StoredRoutine | null> {
    const row = this.db.prepare('SELECT * FROM routines WHERE id = ?').get(routineId) as any;
    return row ? rowToRoutine(row) : null;
  }

  async list(): Promise<StoredRoutine[]> {
    const rows = this.db.prepare('SELECT * FROM routines ORDER BY created_at').all() as any[];
    return rows.map(rowToRoutine);
  }

  async update(routineId: string, updates: Partial<StoredRoutine>): Promise<void> {
    const existing = await this.get(routineId);
    if (!existing) throw new Error(`Routine ${routineId} not found`);

    const merged = { ...existing, ...updates };
    this.db.prepare(`
      UPDATE routines SET name=?, trigger_def=?, actions=?, enabled=?, last_triggered=?
      WHERE id=?
    `).run(
      merged.name, JSON.stringify(merged.trigger), JSON.stringify(merged.actions),
      merged.enabled ? 1 : 0, merged.lastTriggered ?? null, routineId,
    );
  }

  async delete(routineId: string): Promise<boolean> {
    const result = this.db.prepare('DELETE FROM routines WHERE id = ?').run(routineId);
    return result.changes > 0;
  }
}

function rowToRoutine(row: any): StoredRoutine {
  return {
    id: row.id,
    name: row.name,
    trigger: JSON.parse(row.trigger_def),
    actions: JSON.parse(row.actions),
    enabled: row.enabled === 1,
    lastTriggered: row.last_triggered ?? undefined,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Token store
// ---------------------------------------------------------------------------

export class SqliteTokenStore implements TokenStore {
  constructor(private db: Database.Database) {}

  async get(userId: string): Promise<TokenPair | null> {
    const row = this.db.prepare(
      'SELECT * FROM tokens WHERE user_id = ?'
    ).get(userId) as any;
    if (!row) return null;
    return {
      accessToken: row.access_token,
      refreshToken: row.refresh_token,
      expiresAt: row.expires_at,
    };
  }

  async set(userId: string, tokens: TokenPair): Promise<void> {
    this.db.prepare(`
      INSERT INTO tokens (user_id, access_token, refresh_token, expires_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        access_token=excluded.access_token,
        refresh_token=excluded.refresh_token,
        expires_at=excluded.expires_at
    `).run(userId, tokens.accessToken, tokens.refreshToken, tokens.expiresAt);
  }

  async delete(userId: string): Promise<void> {
    this.db.prepare('DELETE FROM tokens WHERE user_id = ?').run(userId);
  }
}
