import { InMemoryActivityStore } from '../../src/alexa-api/activity-store';
import type { ActivityRecord } from '../../src/alexa-api/alexa-api-types';

function makeRecord(overrides: Partial<ActivityRecord> = {}): ActivityRecord {
  return {
    id: `rec-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    utteranceText: 'turn on the lights',
    responseText: 'OK',
    ...overrides,
  };
}

describe('InMemoryActivityStore', () => {
  let store: InMemoryActivityStore;

  beforeEach(() => {
    store = new InMemoryActivityStore();
  });

  it('should insert and query a record', async () => {
    const record = makeRecord({ id: 'rec-1' });
    await store.insert(record);

    const result = await store.query({});
    expect(result.records).toHaveLength(1);
    expect(result.totalCount).toBe(1);
  });

  it('should deduplicate by id', async () => {
    await store.insert(makeRecord({ id: 'dup-1' }));
    await store.insert(makeRecord({ id: 'dup-1' }));
    await store.insert(makeRecord({ id: 'dup-2' }));

    const result = await store.query({});
    expect(result.totalCount).toBe(2);
  });

  it('should insert batch with dedup', async () => {
    await store.insertBatch([
      makeRecord({ id: 'b1' }),
      makeRecord({ id: 'b2' }),
      makeRecord({ id: 'b1' }), // duplicate
    ]);

    const result = await store.query({});
    expect(result.totalCount).toBe(2);
  });

  it('should filter by deviceSerial', async () => {
    await store.insert(makeRecord({ deviceSerial: 'ECHO-1' }));
    await store.insert(makeRecord({ deviceSerial: 'ECHO-2' }));
    await store.insert(makeRecord({ deviceSerial: 'ECHO-1' }));

    const result = await store.query({ deviceSerial: 'ECHO-1' });
    expect(result.records).toHaveLength(2);
  });

  it('should filter by time range', async () => {
    await store.insert(makeRecord({ timestamp: '2024-01-01T00:00:00Z' }));
    await store.insert(makeRecord({ timestamp: '2024-06-15T00:00:00Z' }));
    await store.insert(makeRecord({ timestamp: '2024-12-01T00:00:00Z' }));

    const result = await store.query({
      startTime: '2024-03-01T00:00:00Z',
      endTime: '2024-09-01T00:00:00Z',
    });
    expect(result.records).toHaveLength(1);
  });

  it('should search by text in utterance and response', async () => {
    await store.insert(makeRecord({ utteranceText: 'turn on the lights', responseText: 'OK' }));
    await store.insert(makeRecord({ utteranceText: 'what time is it', responseText: "It's 3pm" }));
    await store.insert(makeRecord({ utteranceText: 'set volume', responseText: 'lights are now off' }));

    const byUtterance = await store.query({ searchText: 'lights' });
    expect(byUtterance.records).toHaveLength(2); // "turn on the lights" + "lights are now off" in response

    const byResponse = await store.query({ searchText: 'time' });
    expect(byResponse.records).toHaveLength(1); // "what time is it"
  });

  it('should paginate', async () => {
    for (let i = 0; i < 10; i++) {
      await store.insert(makeRecord());
    }

    const page = await store.query({ limit: 3, offset: 0 });
    expect(page.records).toHaveLength(3);
    expect(page.totalCount).toBe(10);
  });

  it('should get by id', async () => {
    await store.insert(makeRecord({ id: 'find-me' }));
    await store.insert(makeRecord({ id: 'other' }));

    const found = await store.getById('find-me');
    expect(found).not.toBeNull();
    expect(found!.id).toBe('find-me');

    const missing = await store.getById('nonexistent');
    expect(missing).toBeNull();
  });

  it('should prune old records', async () => {
    await store.insert(makeRecord({ timestamp: '2024-01-01T00:00:00Z' }));
    await store.insert(makeRecord({ timestamp: '2024-06-01T00:00:00Z' }));
    await store.insert(makeRecord({ timestamp: '2024-12-01T00:00:00Z' }));

    const pruned = await store.prune('2024-05-01T00:00:00Z');
    expect(pruned).toBe(1);

    const result = await store.query({});
    expect(result.totalCount).toBe(2);
  });

  it('should enforce max records limit', async () => {
    const small = new InMemoryActivityStore(5);
    for (let i = 0; i < 10; i++) {
      await small.insert(makeRecord());
    }

    const result = await small.query({});
    expect(result.totalCount).toBe(5);
  });

  it('should handle case-insensitive text search', async () => {
    await store.insert(makeRecord({ utteranceText: 'Turn On The Lights' }));

    const result = await store.query({ searchText: 'turn on' });
    expect(result.records).toHaveLength(1);
  });
});
