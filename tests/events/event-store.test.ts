import { InMemoryEventStore } from '../../src/events';
import type { StoredEvent } from '../../src/events';

function makeEvent(overrides: Partial<StoredEvent> = {}): StoredEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    eventType: 'TurnOn',
    namespace: 'Alexa.PowerController',
    endpointId: 'light-1',
    userId: 'user-1',
    payload: {},
    ...overrides,
  };
}

describe('InMemoryEventStore', () => {
  let store: InMemoryEventStore;

  beforeEach(() => {
    store = new InMemoryEventStore(100);
  });

  it('should insert and retrieve events by ID', async () => {
    const event = makeEvent({ id: 'evt-1' });
    await store.insert(event);

    const retrieved = await store.getById('evt-1');
    expect(retrieved).toEqual(event);
  });

  it('should return null for nonexistent event', async () => {
    expect(await store.getById('nonexistent')).toBeNull();
  });

  it('should query all events with no filters', async () => {
    await store.insert(makeEvent({ id: 'e1' }));
    await store.insert(makeEvent({ id: 'e2' }));
    await store.insert(makeEvent({ id: 'e3' }));

    const result = await store.query({});
    expect(result.events).toHaveLength(3);
    expect(result.totalCount).toBe(3);
  });

  it('should filter events by endpointId', async () => {
    await store.insert(makeEvent({ endpointId: 'light-1' }));
    await store.insert(makeEvent({ endpointId: 'light-2' }));
    await store.insert(makeEvent({ endpointId: 'light-1' }));

    const result = await store.query({ endpointId: 'light-1' });
    expect(result.events).toHaveLength(2);
  });

  it('should filter events by userId', async () => {
    await store.insert(makeEvent({ userId: 'user-1' }));
    await store.insert(makeEvent({ userId: 'user-2' }));

    const result = await store.query({ userId: 'user-2' });
    expect(result.events).toHaveLength(1);
  });

  it('should filter events by eventType', async () => {
    await store.insert(makeEvent({ eventType: 'TurnOn' }));
    await store.insert(makeEvent({ eventType: 'TurnOff' }));
    await store.insert(makeEvent({ eventType: 'TurnOn' }));

    const result = await store.query({ eventType: 'TurnOff' });
    expect(result.events).toHaveLength(1);
  });

  it('should filter events by namespace', async () => {
    await store.insert(makeEvent({ namespace: 'Alexa.PowerController' }));
    await store.insert(makeEvent({ namespace: 'Alexa.BrightnessController' }));

    const result = await store.query({ namespace: 'Alexa.BrightnessController' });
    expect(result.events).toHaveLength(1);
  });

  it('should filter events by time range', async () => {
    await store.insert(makeEvent({ timestamp: '2024-01-01T00:00:00Z' }));
    await store.insert(makeEvent({ timestamp: '2024-06-15T12:00:00Z' }));
    await store.insert(makeEvent({ timestamp: '2024-12-31T23:59:59Z' }));

    const result = await store.query({
      startTime: '2024-03-01T00:00:00Z',
      endTime: '2024-09-01T00:00:00Z',
    });
    expect(result.events).toHaveLength(1);
  });

  it('should filter events by tags', async () => {
    await store.insert(makeEvent({ tags: ['power', 'state_change'] }));
    await store.insert(makeEvent({ tags: ['brightness'] }));
    await store.insert(makeEvent({ tags: ['power'] }));

    const result = await store.query({ tags: ['power'] });
    expect(result.events).toHaveLength(2);

    const result2 = await store.query({ tags: ['power', 'state_change'] });
    expect(result2.events).toHaveLength(1);
  });

  it('should paginate results with limit', async () => {
    for (let i = 0; i < 10; i++) {
      await store.insert(makeEvent({ id: `evt-${i}` }));
    }

    const result = await store.query({ limit: 3 });
    expect(result.events).toHaveLength(3);
    expect(result.totalCount).toBe(10);
    expect(result.cursor).toBeTruthy();
  });

  it('should paginate results with cursor', async () => {
    for (let i = 0; i < 5; i++) {
      await store.insert(makeEvent({ id: `evt-${i}` }));
    }

    const page1 = await store.query({ limit: 2 });
    expect(page1.events).toHaveLength(2);
    expect(page1.cursor).toBeTruthy();

    const page2 = await store.query({ limit: 2, cursor: page1.cursor });
    expect(page2.events).toHaveLength(2);

    // Events should not overlap
    const page1Ids = page1.events.map((e) => e.id);
    const page2Ids = page2.events.map((e) => e.id);
    expect(page1Ids.filter((id) => page2Ids.includes(id))).toHaveLength(0);
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

  it('should enforce maxEvents limit', async () => {
    const smallStore = new InMemoryEventStore(5);
    for (let i = 0; i < 10; i++) {
      await smallStore.insert(makeEvent({ id: `evt-${i}` }));
    }
    expect(await smallStore.count()).toBe(5);
  });

  it('should insert batch of events', async () => {
    const events = [makeEvent({ id: 'b1' }), makeEvent({ id: 'b2' }), makeEvent({ id: 'b3' })];
    await store.insertBatch(events);
    expect(await store.count()).toBe(3);
  });
});
