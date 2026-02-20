import path from 'path';
import fs from 'fs';
import { SqliteStorage, SqliteEventStore, SqliteRoutineStore, SqliteTokenStore } from '../../src/storage/sqlite';
import type { StoredEvent } from '../../src/events/event-store';
import type { StoredRoutine } from '../../src/routines/routine-store';
import type { TokenPair } from '../../src/auth/token-store';

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

  it('should provide all three store types', () => {
    expect(storage.events()).toBeInstanceOf(SqliteEventStore);
    expect(storage.routines()).toBeInstanceOf(SqliteRoutineStore);
    expect(storage.tokens()).toBeInstanceOf(SqliteTokenStore);
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
