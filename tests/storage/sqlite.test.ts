import path from 'path';
import fs from 'fs';
import { SqliteStorage, SqliteEventStore, SqliteRoutineStore, SqliteTokenStore, SqliteCookieStore, SqliteDeviceStateStore, SqliteActivityStore } from '../../src/storage/sqlite';
import type { StoredEvent } from '../../src/events/event-store';
import type { StoredRoutine } from '../../src/routines/routine-store';
import type { TokenPair } from '../../src/auth/token-store';
import type { AlexaCookieCredentials, DeviceStateSnapshot, ActivityRecord } from '../../src/alexa-api/alexa-api-types';

const TEST_DB = path.join(__dirname, '..', 'test-storage.db');

function makeEvent(overrides: Partial<StoredEvent> = {}): StoredEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    eventType: 'TurnOn',
    namespace: 'Alexa.PowerController',
    endpointId: 'light-1',
    userId: 'user-1',
    payload: {},
    tags: [],
    ...overrides,
  };
}

describe('SqliteStorage', () => {
  let storage: SqliteStorage;

  beforeEach(() => {
    // Remove any existing test DB
    try { fs.unlinkSync(TEST_DB); } catch {}
    storage = new SqliteStorage(TEST_DB);
  });

  afterEach(() => {
    storage.close();
    try { fs.unlinkSync(TEST_DB); } catch {}
  });

  it('should create the database file', () => {
    expect(fs.existsSync(TEST_DB)).toBe(true);
  });

  it('should provide all store types', () => {
    expect(storage.events()).toBeInstanceOf(SqliteEventStore);
    expect(storage.routines()).toBeInstanceOf(SqliteRoutineStore);
    expect(storage.tokens()).toBeInstanceOf(SqliteTokenStore);
    expect(storage.cookies()).toBeInstanceOf(SqliteCookieStore);
    expect(storage.deviceStates()).toBeInstanceOf(SqliteDeviceStateStore);
    expect(storage.activities()).toBeInstanceOf(SqliteActivityStore);
  });
});

describe('SqliteEventStore', () => {
  let storage: SqliteStorage;
  let store: SqliteEventStore;

  beforeEach(() => {
    try { fs.unlinkSync(TEST_DB); } catch {}
    storage = new SqliteStorage(TEST_DB);
    store = storage.events();
  });

  afterEach(() => {
    storage.close();
    try { fs.unlinkSync(TEST_DB); } catch {}
  });

  it('should insert and retrieve by ID', async () => {
    const event = makeEvent({ id: 'evt-1' });
    await store.insert(event);
    const retrieved = await store.getById('evt-1');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe('evt-1');
    expect(retrieved!.eventType).toBe('TurnOn');
  });

  it('should return null for missing event', async () => {
    expect(await store.getById('nonexistent')).toBeNull();
  });

  it('should query with filters', async () => {
    await store.insert(makeEvent({ id: 'e1', endpointId: 'light-1', eventType: 'TurnOn' }));
    await store.insert(makeEvent({ id: 'e2', endpointId: 'light-2', eventType: 'TurnOff' }));
    await store.insert(makeEvent({ id: 'e3', endpointId: 'light-1', eventType: 'TurnOff' }));

    const byEndpoint = await store.query({ endpointId: 'light-1' });
    expect(byEndpoint.events).toHaveLength(2);
    expect(byEndpoint.totalCount).toBe(2);

    const byType = await store.query({ eventType: 'TurnOff' });
    expect(byType.events).toHaveLength(2);
  });

  it('should filter by time range', async () => {
    await store.insert(makeEvent({ id: 'e1', timestamp: '2024-01-01T00:00:00Z' }));
    await store.insert(makeEvent({ id: 'e2', timestamp: '2024-06-15T00:00:00Z' }));
    await store.insert(makeEvent({ id: 'e3', timestamp: '2024-12-01T00:00:00Z' }));

    const result = await store.query({
      startTime: '2024-03-01T00:00:00Z',
      endTime: '2024-09-01T00:00:00Z',
    });
    expect(result.events).toHaveLength(1);
    expect(result.events[0].id).toBe('e2');
  });

  it('should filter by tags', async () => {
    await store.insert(makeEvent({ id: 'e1', tags: ['power', 'state_change'] }));
    await store.insert(makeEvent({ id: 'e2', tags: ['brightness'] }));

    const result = await store.query({ tags: ['power'] });
    expect(result.events).toHaveLength(1);
    expect(result.events[0].id).toBe('e1');
  });

  it('should paginate with limit', async () => {
    for (let i = 0; i < 10; i++) {
      await store.insert(makeEvent({ id: `evt-${i}`, timestamp: `2024-01-${String(i + 1).padStart(2, '0')}T00:00:00Z` }));
    }

    const page = await store.query({ limit: 3 });
    expect(page.events).toHaveLength(3);
    expect(page.totalCount).toBe(10);
    expect(page.cursor).toBeTruthy();
  });

  it('should insert batch', async () => {
    const events = [makeEvent({ id: 'b1' }), makeEvent({ id: 'b2' }), makeEvent({ id: 'b3' })];
    await store.insertBatch(events);
    expect(await store.count()).toBe(3);
  });

  it('should count events', async () => {
    await store.insert(makeEvent({ endpointId: 'a' }));
    await store.insert(makeEvent({ endpointId: 'b' }));
    await store.insert(makeEvent({ endpointId: 'a' }));

    expect(await store.count()).toBe(3);
    expect(await store.count({ endpointId: 'a' })).toBe(2);
  });

  it('should prune old events', async () => {
    await store.insert(makeEvent({ timestamp: '2024-01-01T00:00:00Z' }));
    await store.insert(makeEvent({ timestamp: '2024-06-01T00:00:00Z' }));
    await store.insert(makeEvent({ timestamp: '2024-12-01T00:00:00Z' }));

    const pruned = await store.prune('2024-05-01T00:00:00Z');
    expect(pruned).toBe(1);
    expect(await store.count()).toBe(2);
  });

  it('should persist across storage reopen', async () => {
    await store.insert(makeEvent({ id: 'persist-1' }));
    storage.close();

    const storage2 = new SqliteStorage(TEST_DB);
    const store2 = storage2.events();
    const retrieved = await store2.getById('persist-1');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe('persist-1');
    storage2.close();
  });
});

describe('SqliteRoutineStore', () => {
  let storage: SqliteStorage;
  let store: SqliteRoutineStore;

  beforeEach(() => {
    try { fs.unlinkSync(TEST_DB); } catch {}
    storage = new SqliteStorage(TEST_DB);
    store = storage.routines();
  });

  afterEach(() => {
    storage.close();
    try { fs.unlinkSync(TEST_DB); } catch {}
  });

  const sampleRoutine: StoredRoutine = {
    id: 'r-1',
    name: 'Bedtime',
    trigger: { type: 'schedule', cron: '0 22 * * *' },
    actions: [{ type: 'device_command', endpointId: 'light-1', command: { action: 'turn_off' } }],
    enabled: true,
    createdAt: '2024-01-01T00:00:00Z',
  };

  it('should create and retrieve a routine', async () => {
    await store.create(sampleRoutine);
    const retrieved = await store.get('r-1');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.name).toBe('Bedtime');
    expect(retrieved!.trigger).toEqual({ type: 'schedule', cron: '0 22 * * *' });
    expect(retrieved!.actions).toHaveLength(1);
  });

  it('should return null for missing routine', async () => {
    expect(await store.get('nonexistent')).toBeNull();
  });

  it('should list all routines', async () => {
    await store.create(sampleRoutine);
    await store.create({ ...sampleRoutine, id: 'r-2', name: 'Morning' });
    const all = await store.list();
    expect(all).toHaveLength(2);
  });

  it('should update a routine', async () => {
    await store.create(sampleRoutine);
    await store.update('r-1', { name: 'Updated', lastTriggered: '2024-06-01T00:00:00Z' });
    const updated = await store.get('r-1');
    expect(updated!.name).toBe('Updated');
    expect(updated!.lastTriggered).toBe('2024-06-01T00:00:00Z');
  });

  it('should throw when updating nonexistent routine', async () => {
    await expect(store.update('nonexistent', { name: 'x' })).rejects.toThrow('not found');
  });

  it('should delete a routine', async () => {
    await store.create(sampleRoutine);
    expect(await store.delete('r-1')).toBe(true);
    expect(await store.get('r-1')).toBeNull();
  });

  it('should return false when deleting nonexistent', async () => {
    expect(await store.delete('nonexistent')).toBe(false);
  });

  it('should persist across reopen', async () => {
    await store.create(sampleRoutine);
    storage.close();

    const storage2 = new SqliteStorage(TEST_DB);
    const store2 = storage2.routines();
    expect(await store2.get('r-1')).not.toBeNull();
    storage2.close();
  });
});

describe('SqliteTokenStore', () => {
  let storage: SqliteStorage;
  let store: SqliteTokenStore;

  beforeEach(() => {
    try { fs.unlinkSync(TEST_DB); } catch {}
    storage = new SqliteStorage(TEST_DB);
    store = storage.tokens();
  });

  afterEach(() => {
    storage.close();
    try { fs.unlinkSync(TEST_DB); } catch {}
  });

  const sampleTokens: TokenPair = {
    accessToken: 'Atza|test-access',
    refreshToken: 'Atzr|test-refresh',
    expiresAt: Date.now() + 3600000,
  };

  it('should return null for missing user', async () => {
    expect(await store.get('nonexistent')).toBeNull();
  });

  it('should set and get tokens', async () => {
    await store.set('user-1', sampleTokens);
    const retrieved = await store.get('user-1');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.accessToken).toBe('Atza|test-access');
    expect(retrieved!.refreshToken).toBe('Atzr|test-refresh');
  });

  it('should overwrite existing tokens (upsert)', async () => {
    await store.set('user-1', sampleTokens);
    const updated: TokenPair = { accessToken: 'new', refreshToken: 'new', expiresAt: 999 };
    await store.set('user-1', updated);
    const retrieved = await store.get('user-1');
    expect(retrieved!.accessToken).toBe('new');
  });

  it('should delete tokens', async () => {
    await store.set('user-1', sampleTokens);
    await store.delete('user-1');
    expect(await store.get('user-1')).toBeNull();
  });

  it('should persist across reopen', async () => {
    await store.set('user-1', sampleTokens);
    storage.close();

    const storage2 = new SqliteStorage(TEST_DB);
    const store2 = storage2.tokens();
    const retrieved = await store2.get('user-1');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.accessToken).toBe('Atza|test-access');
    storage2.close();
  });
});

describe('SqliteCookieStore', () => {
  let storage: SqliteStorage;
  let store: SqliteCookieStore;

  beforeEach(() => {
    try { fs.unlinkSync(TEST_DB); } catch {}
    storage = new SqliteStorage(TEST_DB);
    store = storage.cookies();
  });

  afterEach(() => {
    storage.close();
    try { fs.unlinkSync(TEST_DB); } catch {}
  });

  const sampleCreds: AlexaCookieCredentials = {
    cookie: 'session-id=abc123; csrf=token456',
    csrf: 'token456',
    storedAt: '2026-01-15T10:00:00.000Z',
  };

  it('should return null for missing user', async () => {
    expect(await store.get('nonexistent')).toBeNull();
  });

  it('should store and retrieve cookie credentials', async () => {
    await store.set('user-1', sampleCreds);
    const retrieved = await store.get('user-1');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.cookie).toBe('session-id=abc123; csrf=token456');
    expect(retrieved!.csrf).toBe('token456');
    expect(retrieved!.storedAt).toBe('2026-01-15T10:00:00.000Z');
  });

  it('should handle optional fields', async () => {
    const minimal: AlexaCookieCredentials = {
      cookie: 'minimal-cookie',
      storedAt: '2026-01-15T10:00:00.000Z',
    };
    await store.set('user-1', minimal);
    const retrieved = await store.get('user-1');
    expect(retrieved!.cookie).toBe('minimal-cookie');
    expect(retrieved!.csrf).toBeUndefined();
    expect(retrieved!.expiresAt).toBeUndefined();
  });

  it('should upsert on conflict', async () => {
    await store.set('user-1', sampleCreds);
    const updated: AlexaCookieCredentials = {
      cookie: 'new-cookie',
      csrf: 'new-csrf',
      storedAt: '2026-02-01T00:00:00.000Z',
      expiresAt: '2026-02-15T00:00:00.000Z',
    };
    await store.set('user-1', updated);
    const retrieved = await store.get('user-1');
    expect(retrieved!.cookie).toBe('new-cookie');
    expect(retrieved!.csrf).toBe('new-csrf');
    expect(retrieved!.expiresAt).toBe('2026-02-15T00:00:00.000Z');
  });

  it('should delete cookie credentials', async () => {
    await store.set('user-1', sampleCreds);
    await store.delete('user-1');
    expect(await store.get('user-1')).toBeNull();
  });

  it('should persist across reopen', async () => {
    await store.set('user-1', sampleCreds);
    storage.close();

    const storage2 = new SqliteStorage(TEST_DB);
    const store2 = storage2.cookies();
    const retrieved = await store2.get('user-1');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.cookie).toBe('session-id=abc123; csrf=token456');
    storage2.close();
  });
});

describe('SqliteDeviceStateStore', () => {
  let storage: SqliteStorage;
  let store: SqliteDeviceStateStore;

  beforeEach(() => {
    try { fs.unlinkSync(TEST_DB); } catch {}
    storage = new SqliteStorage(TEST_DB);
    store = storage.deviceStates();
  });

  afterEach(() => {
    storage.close();
    try { fs.unlinkSync(TEST_DB); } catch {}
  });

  const sampleSnapshot: DeviceStateSnapshot = {
    deviceId: 'entity-1',
    deviceName: 'Kitchen Light',
    capabilities: [
      { namespace: 'Alexa.PowerController', name: 'powerState', value: 'ON' },
      { namespace: 'Alexa.BrightnessController', name: 'brightness', value: 75 },
    ],
    polledAt: '2024-06-01T12:00:00Z',
  };

  it('should insert and query a snapshot', async () => {
    await store.insert(sampleSnapshot);
    const result = await store.query({});
    expect(result.snapshots).toHaveLength(1);
    expect(result.totalCount).toBe(1);
    expect(result.snapshots[0].deviceId).toBe('entity-1');
    expect(result.snapshots[0].deviceName).toBe('Kitchen Light');
    expect(result.snapshots[0].capabilities).toHaveLength(2);
    expect(result.snapshots[0].capabilities[0].value).toBe('ON');
  });

  it('should insert batch', async () => {
    await store.insertBatch([
      { ...sampleSnapshot, deviceId: 'a' },
      { ...sampleSnapshot, deviceId: 'b' },
      { ...sampleSnapshot, deviceId: 'c' },
    ]);
    const result = await store.query({});
    expect(result.totalCount).toBe(3);
  });

  it('should filter by deviceId', async () => {
    await store.insert({ ...sampleSnapshot, deviceId: 'light-1' });
    await store.insert({ ...sampleSnapshot, deviceId: 'plug-1' });
    await store.insert({ ...sampleSnapshot, deviceId: 'light-1', polledAt: '2024-07-01T00:00:00Z' });

    const result = await store.query({ deviceId: 'light-1' });
    expect(result.totalCount).toBe(2);
  });

  it('should filter by time range', async () => {
    await store.insert({ ...sampleSnapshot, polledAt: '2024-01-01T00:00:00Z' });
    await store.insert({ ...sampleSnapshot, polledAt: '2024-06-15T00:00:00Z' });
    await store.insert({ ...sampleSnapshot, polledAt: '2024-12-01T00:00:00Z' });

    const result = await store.query({
      startTime: '2024-03-01T00:00:00Z',
      endTime: '2024-09-01T00:00:00Z',
    });
    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0].polledAt).toBe('2024-06-15T00:00:00Z');
  });

  it('should paginate with limit and offset', async () => {
    for (let i = 0; i < 10; i++) {
      await store.insert({
        ...sampleSnapshot,
        polledAt: `2024-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
      });
    }

    const page = await store.query({ limit: 3, offset: 0 });
    expect(page.snapshots).toHaveLength(3);
    expect(page.totalCount).toBe(10);
  });

  it('should get latest snapshot for a device', async () => {
    await store.insert({ ...sampleSnapshot, deviceId: 'light-1', polledAt: '2024-01-01T00:00:00Z' });
    await store.insert({ ...sampleSnapshot, deviceId: 'light-1', polledAt: '2024-12-01T00:00:00Z' });

    const latest = await store.getLatest('light-1');
    expect(latest).not.toBeNull();
    expect(latest!.polledAt).toBe('2024-12-01T00:00:00Z');
  });

  it('should return null for unknown device in getLatest', async () => {
    expect(await store.getLatest('nonexistent')).toBeNull();
  });

  it('should prune old snapshots', async () => {
    await store.insert({ ...sampleSnapshot, polledAt: '2024-01-01T00:00:00Z' });
    await store.insert({ ...sampleSnapshot, polledAt: '2024-06-01T00:00:00Z' });
    await store.insert({ ...sampleSnapshot, polledAt: '2024-12-01T00:00:00Z' });

    const pruned = await store.prune('2024-05-01T00:00:00Z');
    expect(pruned).toBe(1);

    const result = await store.query({});
    expect(result.totalCount).toBe(2);
  });

  it('should store error snapshots', async () => {
    await store.insert({
      deviceId: 'broken-1',
      capabilities: [],
      polledAt: '2024-06-01T00:00:00Z',
      error: 'DEVICE_UNREACHABLE',
    });

    const result = await store.query({ deviceId: 'broken-1' });
    expect(result.snapshots[0].error).toBe('DEVICE_UNREACHABLE');
    expect(result.snapshots[0].capabilities).toEqual([]);
  });

  it('should persist across reopen', async () => {
    await store.insert(sampleSnapshot);
    storage.close();

    const storage2 = new SqliteStorage(TEST_DB);
    const store2 = storage2.deviceStates();
    const result = await store2.query({ deviceId: 'entity-1' });
    expect(result.totalCount).toBe(1);
    expect(result.snapshots[0].capabilities).toHaveLength(2);
    storage2.close();
  });
});

describe('SqliteActivityStore', () => {
  let storage: SqliteStorage;
  let store: SqliteActivityStore;

  beforeEach(() => {
    try { fs.unlinkSync(TEST_DB); } catch {}
    storage = new SqliteStorage(TEST_DB);
    store = storage.activities();
  });

  afterEach(() => {
    storage.close();
    try { fs.unlinkSync(TEST_DB); } catch {}
  });

  const sampleRecord: ActivityRecord = {
    id: 'rec-1',
    timestamp: '2024-06-01T12:00:00Z',
    deviceSerial: 'ECHO-1',
    deviceName: 'Kitchen Echo',
    deviceType: 'ECHO_DOT',
    utteranceText: 'turn on the lights',
    responseText: 'OK',
    utteranceType: 'VOICE',
  };

  it('should insert and query a record', async () => {
    await store.insert(sampleRecord);
    const result = await store.query({});
    expect(result.records).toHaveLength(1);
    expect(result.totalCount).toBe(1);
    expect(result.records[0].id).toBe('rec-1');
    expect(result.records[0].utteranceText).toBe('turn on the lights');
  });

  it('should deduplicate by id (INSERT OR IGNORE)', async () => {
    await store.insert(sampleRecord);
    await store.insert({ ...sampleRecord, utteranceText: 'modified' }); // same id

    const result = await store.query({});
    expect(result.totalCount).toBe(1);
    // Should keep the original, not the duplicate
    expect(result.records[0].utteranceText).toBe('turn on the lights');
  });

  it('should insert batch with dedup', async () => {
    await store.insertBatch([
      { ...sampleRecord, id: 'b1' },
      { ...sampleRecord, id: 'b2' },
      { ...sampleRecord, id: 'b1' }, // duplicate
    ]);

    const result = await store.query({});
    expect(result.totalCount).toBe(2);
  });

  it('should filter by deviceSerial', async () => {
    await store.insert({ ...sampleRecord, id: 'r1', deviceSerial: 'ECHO-1' });
    await store.insert({ ...sampleRecord, id: 'r2', deviceSerial: 'ECHO-2' });
    await store.insert({ ...sampleRecord, id: 'r3', deviceSerial: 'ECHO-1' });

    const result = await store.query({ deviceSerial: 'ECHO-1' });
    expect(result.totalCount).toBe(2);
  });

  it('should filter by time range', async () => {
    await store.insert({ ...sampleRecord, id: 'r1', timestamp: '2024-01-01T00:00:00Z' });
    await store.insert({ ...sampleRecord, id: 'r2', timestamp: '2024-06-15T00:00:00Z' });
    await store.insert({ ...sampleRecord, id: 'r3', timestamp: '2024-12-01T00:00:00Z' });

    const result = await store.query({
      startTime: '2024-03-01T00:00:00Z',
      endTime: '2024-09-01T00:00:00Z',
    });
    expect(result.records).toHaveLength(1);
    expect(result.records[0].id).toBe('r2');
  });

  it('should search by text (LIKE)', async () => {
    await store.insert({ ...sampleRecord, id: 'r1', utteranceText: 'turn on the lights', responseText: 'OK' });
    await store.insert({ ...sampleRecord, id: 'r2', utteranceText: 'what time is it', responseText: "It's 3pm" });
    await store.insert({ ...sampleRecord, id: 'r3', utteranceText: 'set volume', responseText: 'lights are now off' });

    const result = await store.query({ searchText: 'lights' });
    expect(result.totalCount).toBe(2);
  });

  it('should paginate with limit and offset', async () => {
    for (let i = 0; i < 10; i++) {
      await store.insert({
        ...sampleRecord,
        id: `r-${i}`,
        timestamp: `2024-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
      });
    }

    const page = await store.query({ limit: 3, offset: 0 });
    expect(page.records).toHaveLength(3);
    expect(page.totalCount).toBe(10);
  });

  it('should get by id', async () => {
    await store.insert(sampleRecord);
    const found = await store.getById('rec-1');
    expect(found).not.toBeNull();
    expect(found!.utteranceText).toBe('turn on the lights');

    const missing = await store.getById('nonexistent');
    expect(missing).toBeNull();
  });

  it('should prune old records', async () => {
    await store.insert({ ...sampleRecord, id: 'r1', timestamp: '2024-01-01T00:00:00Z' });
    await store.insert({ ...sampleRecord, id: 'r2', timestamp: '2024-06-01T00:00:00Z' });
    await store.insert({ ...sampleRecord, id: 'r3', timestamp: '2024-12-01T00:00:00Z' });

    const pruned = await store.prune('2024-05-01T00:00:00Z');
    expect(pruned).toBe(1);
    expect((await store.query({})).totalCount).toBe(2);
  });

  it('should handle optional fields', async () => {
    const minimal: ActivityRecord = {
      id: 'min-1',
      timestamp: '2024-06-01T00:00:00Z',
    };
    await store.insert(minimal);
    const retrieved = await store.getById('min-1');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.deviceSerial).toBeUndefined();
    expect(retrieved!.utteranceText).toBeUndefined();
  });

  it('should store and retrieve raw data', async () => {
    const withRaw: ActivityRecord = {
      ...sampleRecord,
      id: 'raw-1',
      raw: { extra: 'data', nested: { key: 'value' } },
    };
    await store.insert(withRaw);
    const retrieved = await store.getById('raw-1');
    expect(retrieved!.raw).toEqual({ extra: 'data', nested: { key: 'value' } });
  });

  it('should persist across reopen', async () => {
    await store.insert(sampleRecord);
    storage.close();

    const storage2 = new SqliteStorage(TEST_DB);
    const store2 = storage2.activities();
    const result = await store2.getById('rec-1');
    expect(result).not.toBeNull();
    expect(result!.utteranceText).toBe('turn on the lights');
    storage2.close();
  });
});
