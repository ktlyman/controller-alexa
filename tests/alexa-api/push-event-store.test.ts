import { InMemoryPushEventStore } from '../../src/alexa-api/push-event-store';
import type { StoredPushEvent } from '../../src/alexa-api/push-event-types';

function makeEvent(overrides: Partial<StoredPushEvent> = {}): StoredPushEvent {
  return {
    id: `pe-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    command: 'PUSH_ACTIVITY',
    payload: {},
    processed: false,
    ...overrides,
  };
}

describe('InMemoryPushEventStore', () => {
  let store: InMemoryPushEventStore;

  beforeEach(() => {
    store = new InMemoryPushEventStore();
  });

  it('should insert and query an event', async () => {
    await store.insert(makeEvent({ id: 'pe-1' }));
    const result = await store.query({});
    expect(result.events).toHaveLength(1);
    expect(result.totalCount).toBe(1);
  });

  it('should deduplicate by id', async () => {
    await store.insert(makeEvent({ id: 'dup-1' }));
    await store.insert(makeEvent({ id: 'dup-1' }));
    const result = await store.query({});
    expect(result.totalCount).toBe(1);
  });

  it('should insert batch with dedup', async () => {
    await store.insertBatch([
      makeEvent({ id: 'b1' }),
      makeEvent({ id: 'b2' }),
      makeEvent({ id: 'b1' }),
    ]);
    const result = await store.query({});
    expect(result.totalCount).toBe(2);
  });

  it('should filter by command', async () => {
    await store.insert(makeEvent({ command: 'PUSH_ACTIVITY' }));
    await store.insert(makeEvent({ command: 'PUSH_VOLUME_CHANGE' }));
    await store.insert(makeEvent({ command: 'PUSH_ACTIVITY' }));

    const result = await store.query({ command: 'PUSH_ACTIVITY' });
    expect(result.totalCount).toBe(2);
  });

  it('should filter by deviceSerial', async () => {
    await store.insert(makeEvent({ deviceSerial: 'ECHO-1' }));
    await store.insert(makeEvent({ deviceSerial: 'ECHO-2' }));

    const result = await store.query({ deviceSerial: 'ECHO-1' });
    expect(result.totalCount).toBe(1);
  });

  it('should filter by time range', async () => {
    await store.insert(makeEvent({ timestamp: '2024-01-01T00:00:00Z' }));
    await store.insert(makeEvent({ timestamp: '2024-06-15T00:00:00Z' }));
    await store.insert(makeEvent({ timestamp: '2024-12-01T00:00:00Z' }));

    const result = await store.query({
      startTime: '2024-03-01T00:00:00Z',
      endTime: '2024-09-01T00:00:00Z',
    });
    expect(result.totalCount).toBe(1);
  });

  it('should filter by processed flag', async () => {
    await store.insert(makeEvent({ id: 'p1', processed: false }));
    await store.insert(makeEvent({ id: 'p2', processed: true }));
    await store.insert(makeEvent({ id: 'p3', processed: false }));

    const unprocessed = await store.query({ processed: false });
    expect(unprocessed.totalCount).toBe(2);

    const processed = await store.query({ processed: true });
    expect(processed.totalCount).toBe(1);
  });

  it('should paginate', async () => {
    for (let i = 0; i < 10; i++) {
      await store.insert(makeEvent());
    }

    const page = await store.query({ limit: 3, offset: 0 });
    expect(page.events).toHaveLength(3);
    expect(page.totalCount).toBe(10);
  });

  it('should get by id', async () => {
    await store.insert(makeEvent({ id: 'find-me', command: 'PUSH_VOLUME_CHANGE' }));
    const found = await store.getById('find-me');
    expect(found).not.toBeNull();
    expect(found!.command).toBe('PUSH_VOLUME_CHANGE');

    expect(await store.getById('nonexistent')).toBeNull();
  });

  it('should mark as processed', async () => {
    await store.insert(makeEvent({ id: 'mark-me', processed: false }));
    await store.markProcessed('mark-me');

    const found = await store.getById('mark-me');
    expect(found!.processed).toBe(true);
  });

  it('should prune old events', async () => {
    await store.insert(makeEvent({ timestamp: '2024-01-01T00:00:00Z' }));
    await store.insert(makeEvent({ timestamp: '2024-06-01T00:00:00Z' }));
    await store.insert(makeEvent({ timestamp: '2024-12-01T00:00:00Z' }));

    const pruned = await store.prune('2024-05-01T00:00:00Z');
    expect(pruned).toBe(1);
    expect((await store.query({})).totalCount).toBe(2);
  });

  it('should enforce max events', async () => {
    const small = new InMemoryPushEventStore(5);
    for (let i = 0; i < 10; i++) {
      await small.insert(makeEvent());
    }
    expect((await small.query({})).totalCount).toBe(5);
  });
});
