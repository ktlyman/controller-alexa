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
import type { CookieStore } from '../alexa-api/cookie-store';
import type { AlexaCookieCredentials, DeviceStateSnapshot, ActivityRecord } from '../alexa-api/alexa-api-types';
import type { DeviceStateStore, DeviceStateQuery, DeviceStateQueryResult } from '../alexa-api/device-state-store';
import type { ActivityStore, ActivityQuery, ActivityQueryResult } from '../alexa-api/activity-store';
import type { PushEventStore, PushEventQuery, PushEventQueryResult } from '../alexa-api/push-event-store';
import type { StoredPushEvent } from '../alexa-api/push-event-types';

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

      CREATE TABLE IF NOT EXISTS cookies (
        user_id TEXT PRIMARY KEY,
        cookie TEXT NOT NULL,
        csrf TEXT,
        stored_at TEXT NOT NULL,
        expires_at TEXT
      );

      CREATE TABLE IF NOT EXISTS device_states (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT NOT NULL,
        device_name TEXT,
        capabilities TEXT NOT NULL DEFAULT '[]',
        polled_at TEXT NOT NULL,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_device_states_device_id ON device_states(device_id);
      CREATE INDEX IF NOT EXISTS idx_device_states_polled_at ON device_states(polled_at);
      CREATE INDEX IF NOT EXISTS idx_device_states_device_polled ON device_states(device_id, polled_at);

      CREATE TABLE IF NOT EXISTS activity_history (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        device_serial TEXT,
        device_name TEXT,
        device_type TEXT,
        utterance_text TEXT,
        response_text TEXT,
        utterance_type TEXT,
        raw TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_activity_timestamp ON activity_history(timestamp);
      CREATE INDEX IF NOT EXISTS idx_activity_device_serial ON activity_history(device_serial);

      CREATE TABLE IF NOT EXISTS push_events (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        command TEXT NOT NULL,
        device_serial TEXT,
        device_type TEXT,
        device_name TEXT,
        payload TEXT NOT NULL DEFAULT '{}',
        processed INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_push_events_timestamp ON push_events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_push_events_command ON push_events(command);
      CREATE INDEX IF NOT EXISTS idx_push_events_device_serial ON push_events(device_serial);
      CREATE INDEX IF NOT EXISTS idx_push_events_command_timestamp ON push_events(command, timestamp);
      CREATE INDEX IF NOT EXISTS idx_push_events_processed ON push_events(processed);
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

  cookies(): SqliteCookieStore {
    return new SqliteCookieStore(this.db);
  }

  deviceStates(): SqliteDeviceStateStore {
    return new SqliteDeviceStateStore(this.db);
  }

  activities(): SqliteActivityStore {
    return new SqliteActivityStore(this.db);
  }

  pushEvents(): SqlitePushEventStore {
    return new SqlitePushEventStore(this.db);
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

export class SqliteCookieStore implements CookieStore {
  constructor(private db: Database.Database) {}

  async get(userId: string): Promise<AlexaCookieCredentials | null> {
    const row = this.db.prepare(
      'SELECT * FROM cookies WHERE user_id = ?'
    ).get(userId) as any;
    if (!row) return null;
    return {
      cookie: row.cookie,
      csrf: row.csrf ?? undefined,
      storedAt: row.stored_at,
      expiresAt: row.expires_at ?? undefined,
    };
  }

  async set(userId: string, creds: AlexaCookieCredentials): Promise<void> {
    this.db.prepare(`
      INSERT INTO cookies (user_id, cookie, csrf, stored_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        cookie=excluded.cookie,
        csrf=excluded.csrf,
        stored_at=excluded.stored_at,
        expires_at=excluded.expires_at
    `).run(userId, creds.cookie, creds.csrf ?? null, creds.storedAt, creds.expiresAt ?? null);
  }

  async delete(userId: string): Promise<void> {
    this.db.prepare('DELETE FROM cookies WHERE user_id = ?').run(userId);
  }
}

// ---------------------------------------------------------------------------
// Token store
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Device state store
// ---------------------------------------------------------------------------

export class SqliteDeviceStateStore implements DeviceStateStore {
  constructor(private db: Database.Database) {}

  async insert(snapshot: DeviceStateSnapshot): Promise<void> {
    this.db.prepare(`
      INSERT INTO device_states (device_id, device_name, capabilities, polled_at, error)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      snapshot.deviceId,
      snapshot.deviceName ?? null,
      JSON.stringify(snapshot.capabilities),
      snapshot.polledAt,
      snapshot.error ?? null,
    );
  }

  async insertBatch(snapshots: DeviceStateSnapshot[]): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO device_states (device_id, device_name, capabilities, polled_at, error)
      VALUES (?, ?, ?, ?, ?)
    `);
    const tx = this.db.transaction((items: DeviceStateSnapshot[]) => {
      for (const s of items) {
        stmt.run(
          s.deviceId,
          s.deviceName ?? null,
          JSON.stringify(s.capabilities),
          s.polledAt,
          s.error ?? null,
        );
      }
    });
    tx(snapshots);
  }

  async query(query: DeviceStateQuery): Promise<DeviceStateQueryResult> {
    const conditions: string[] = [];
    const params: any[] = [];

    if (query.deviceId) { conditions.push('device_id = ?'); params.push(query.deviceId); }
    if (query.startTime) { conditions.push('polled_at >= ?'); params.push(query.startTime); }
    if (query.endTime) { conditions.push('polled_at <= ?'); params.push(query.endTime); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRow = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM device_states ${where}`
    ).get(...params) as { cnt: number };

    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;

    const rows = this.db.prepare(
      `SELECT * FROM device_states ${where} ORDER BY polled_at DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as any[];

    return {
      snapshots: rows.map(rowToDeviceState),
      totalCount: countRow.cnt,
    };
  }

  async getLatest(deviceId: string): Promise<DeviceStateSnapshot | null> {
    const row = this.db.prepare(
      'SELECT * FROM device_states WHERE device_id = ? ORDER BY polled_at DESC LIMIT 1'
    ).get(deviceId) as any;
    return row ? rowToDeviceState(row) : null;
  }

  async prune(olderThan: string): Promise<number> {
    const result = this.db.prepare('DELETE FROM device_states WHERE polled_at < ?').run(olderThan);
    return result.changes;
  }
}

function rowToDeviceState(row: any): DeviceStateSnapshot {
  return {
    deviceId: row.device_id,
    deviceName: row.device_name ?? undefined,
    capabilities: JSON.parse(row.capabilities),
    polledAt: row.polled_at,
    error: row.error ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Activity store
// ---------------------------------------------------------------------------

export class SqliteActivityStore implements ActivityStore {
  constructor(private db: Database.Database) {}

  async insert(record: ActivityRecord): Promise<void> {
    this.db.prepare(`
      INSERT OR IGNORE INTO activity_history
        (id, timestamp, device_serial, device_name, device_type, utterance_text, response_text, utterance_type, raw)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.timestamp,
      record.deviceSerial ?? null,
      record.deviceName ?? null,
      record.deviceType ?? null,
      record.utteranceText ?? null,
      record.responseText ?? null,
      record.utteranceType ?? null,
      record.raw ? JSON.stringify(record.raw) : null,
    );
  }

  async insertBatch(records: ActivityRecord[]): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO activity_history
        (id, timestamp, device_serial, device_name, device_type, utterance_text, response_text, utterance_type, raw)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = this.db.transaction((items: ActivityRecord[]) => {
      for (const r of items) {
        stmt.run(
          r.id, r.timestamp,
          r.deviceSerial ?? null, r.deviceName ?? null, r.deviceType ?? null,
          r.utteranceText ?? null, r.responseText ?? null,
          r.utteranceType ?? null,
          r.raw ? JSON.stringify(r.raw) : null,
        );
      }
    });
    tx(records);
  }

  async query(query: ActivityQuery): Promise<ActivityQueryResult> {
    const conditions: string[] = [];
    const params: any[] = [];

    if (query.deviceSerial) { conditions.push('device_serial = ?'); params.push(query.deviceSerial); }
    if (query.startTime) { conditions.push('timestamp >= ?'); params.push(query.startTime); }
    if (query.endTime) { conditions.push('timestamp <= ?'); params.push(query.endTime); }
    if (query.searchText) {
      conditions.push('(utterance_text LIKE ? OR response_text LIKE ?)');
      const pattern = `%${query.searchText}%`;
      params.push(pattern, pattern);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRow = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM activity_history ${where}`
    ).get(...params) as { cnt: number };

    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;

    const rows = this.db.prepare(
      `SELECT * FROM activity_history ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as any[];

    return {
      records: rows.map(rowToActivity),
      totalCount: countRow.cnt,
    };
  }

  async getById(id: string): Promise<ActivityRecord | null> {
    const row = this.db.prepare(
      'SELECT * FROM activity_history WHERE id = ?'
    ).get(id) as any;
    return row ? rowToActivity(row) : null;
  }

  async prune(olderThan: string): Promise<number> {
    const result = this.db.prepare('DELETE FROM activity_history WHERE timestamp < ?').run(olderThan);
    return result.changes;
  }
}

function rowToActivity(row: any): ActivityRecord {
  return {
    id: row.id,
    timestamp: row.timestamp,
    deviceSerial: row.device_serial ?? undefined,
    deviceName: row.device_name ?? undefined,
    deviceType: row.device_type ?? undefined,
    utteranceText: row.utterance_text ?? undefined,
    responseText: row.response_text ?? undefined,
    utteranceType: row.utterance_type ?? undefined,
    raw: row.raw ? JSON.parse(row.raw) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Push event store
// ---------------------------------------------------------------------------

export class SqlitePushEventStore implements PushEventStore {
  constructor(private db: Database.Database) {}

  async insert(event: StoredPushEvent): Promise<void> {
    this.db.prepare(`
      INSERT OR IGNORE INTO push_events (id, timestamp, command, device_serial, device_type, device_name, payload, processed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.timestamp,
      event.command,
      event.deviceSerial ?? null,
      event.deviceType ?? null,
      event.deviceName ?? null,
      JSON.stringify(event.payload),
      event.processed ? 1 : 0,
    );
  }

  async insertBatch(events: StoredPushEvent[]): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO push_events (id, timestamp, command, device_serial, device_type, device_name, payload, processed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = this.db.transaction((items: StoredPushEvent[]) => {
      for (const e of items) {
        stmt.run(
          e.id, e.timestamp, e.command,
          e.deviceSerial ?? null, e.deviceType ?? null, e.deviceName ?? null,
          JSON.stringify(e.payload),
          e.processed ? 1 : 0,
        );
      }
    });
    tx(events);
  }

  async query(query: PushEventQuery): Promise<PushEventQueryResult> {
    const conditions: string[] = [];
    const params: any[] = [];

    if (query.command) { conditions.push('command = ?'); params.push(query.command); }
    if (query.deviceSerial) { conditions.push('device_serial = ?'); params.push(query.deviceSerial); }
    if (query.startTime) { conditions.push('timestamp >= ?'); params.push(query.startTime); }
    if (query.endTime) { conditions.push('timestamp <= ?'); params.push(query.endTime); }
    if (query.processed !== undefined) { conditions.push('processed = ?'); params.push(query.processed ? 1 : 0); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRow = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM push_events ${where}`
    ).get(...params) as { cnt: number };

    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;

    const rows = this.db.prepare(
      `SELECT * FROM push_events ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as any[];

    return {
      events: rows.map(rowToPushEvent),
      totalCount: countRow.cnt,
    };
  }

  async getById(id: string): Promise<StoredPushEvent | null> {
    const row = this.db.prepare(
      'SELECT * FROM push_events WHERE id = ?'
    ).get(id) as any;
    return row ? rowToPushEvent(row) : null;
  }

  async markProcessed(id: string): Promise<void> {
    this.db.prepare('UPDATE push_events SET processed = 1 WHERE id = ?').run(id);
  }

  async prune(olderThan: string): Promise<number> {
    const result = this.db.prepare('DELETE FROM push_events WHERE timestamp < ?').run(olderThan);
    return result.changes;
  }
}

function rowToPushEvent(row: any): StoredPushEvent {
  return {
    id: row.id,
    timestamp: row.timestamp,
    command: row.command,
    deviceSerial: row.device_serial ?? undefined,
    deviceType: row.device_type ?? undefined,
    deviceName: row.device_name ?? undefined,
    payload: JSON.parse(row.payload),
    processed: row.processed === 1,
  };
}

// ---------------------------------------------------------------------------
// Token store (cookie-based)
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
