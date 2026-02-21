import { InMemoryDeviceStateStore } from '../../src/alexa-api/device-state-store';
import type { DeviceStateSnapshot } from '../../src/alexa-api/alexa-api-types';

function makeSnapshot(overrides: Partial<DeviceStateSnapshot> = {}): DeviceStateSnapshot {
  return {
    deviceId: 'device-1',
    capabilities: [
      { namespace: 'Alexa.PowerController', name: 'powerState', value: 'ON' },
    ],
    polledAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('InMemoryDeviceStateStore', () => {
  let store: InMemoryDeviceStateStore;

  beforeEach(() => {
    store = new InMemoryDeviceStateStore();
  });

  it('should insert and query a snapshot', async () => {
    const snap = makeSnapshot();
    await store.insert(snap);

    const result = await store.query({});
    expect(result.snapshots).toHaveLength(1);
    expect(result.totalCount).toBe(1);
    expect(result.snapshots[0].deviceId).toBe('device-1');
  });

  it('should insert batch', async () => {
    await store.insertBatch([
      makeSnapshot({ deviceId: 'a' }),
      makeSnapshot({ deviceId: 'b' }),
      makeSnapshot({ deviceId: 'c' }),
    ]);

    const result = await store.query({});
    expect(result.totalCount).toBe(3);
  });

  it('should filter by deviceId', async () => {
    await store.insert(makeSnapshot({ deviceId: 'light-1' }));
    await store.insert(makeSnapshot({ deviceId: 'plug-1' }));
    await store.insert(makeSnapshot({ deviceId: 'light-1' }));

    const result = await store.query({ deviceId: 'light-1' });
    expect(result.snapshots).toHaveLength(2);
    expect(result.totalCount).toBe(2);
  });

  it('should filter by time range', async () => {
    await store.insert(makeSnapshot({ polledAt: '2024-01-01T00:00:00Z' }));
    await store.insert(makeSnapshot({ polledAt: '2024-06-15T00:00:00Z' }));
    await store.insert(makeSnapshot({ polledAt: '2024-12-01T00:00:00Z' }));

    const result = await store.query({
      startTime: '2024-03-01T00:00:00Z',
      endTime: '2024-09-01T00:00:00Z',
    });
    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0].polledAt).toBe('2024-06-15T00:00:00Z');
  });

  it('should paginate with limit and offset', async () => {
    for (let i = 0; i < 10; i++) {
      await store.insert(makeSnapshot({ deviceId: `dev-${i}` }));
    }

    const page1 = await store.query({ limit: 3, offset: 0 });
    expect(page1.snapshots).toHaveLength(3);
    expect(page1.totalCount).toBe(10);

    const page2 = await store.query({ limit: 3, offset: 3 });
    expect(page2.snapshots).toHaveLength(3);
  });

  it('should get latest snapshot for a device', async () => {
    await store.insert(makeSnapshot({ deviceId: 'light-1', polledAt: '2024-01-01T00:00:00Z' }));
    await store.insert(makeSnapshot({ deviceId: 'light-1', polledAt: '2024-06-01T00:00:00Z' }));
    await store.insert(makeSnapshot({ deviceId: 'plug-1', polledAt: '2024-12-01T00:00:00Z' }));

    // InMemory stores newest first (unshift), so the first match is latest
    const latest = await store.getLatest('light-1');
    expect(latest).not.toBeNull();
    expect(latest!.polledAt).toBe('2024-06-01T00:00:00Z');
  });

  it('should return null for unknown device in getLatest', async () => {
    const result = await store.getLatest('nonexistent');
    expect(result).toBeNull();
  });

  it('should prune old snapshots', async () => {
    await store.insert(makeSnapshot({ polledAt: '2024-01-01T00:00:00Z' }));
    await store.insert(makeSnapshot({ polledAt: '2024-06-01T00:00:00Z' }));
    await store.insert(makeSnapshot({ polledAt: '2024-12-01T00:00:00Z' }));

    const pruned = await store.prune('2024-05-01T00:00:00Z');
    expect(pruned).toBe(1);

    const result = await store.query({});
    expect(result.totalCount).toBe(2);
  });

  it('should enforce max snapshots limit', async () => {
    const small = new InMemoryDeviceStateStore(5);
    for (let i = 0; i < 10; i++) {
      await small.insert(makeSnapshot({ deviceId: `dev-${i}` }));
    }

    const result = await small.query({});
    expect(result.totalCount).toBe(5);
  });

  it('should store error snapshots', async () => {
    const snap = makeSnapshot({
      capabilities: [],
      error: 'DEVICE_UNREACHABLE: Device not responding',
    });
    await store.insert(snap);

    const result = await store.query({});
    expect(result.snapshots[0].error).toBe('DEVICE_UNREACHABLE: Device not responding');
    expect(result.snapshots[0].capabilities).toEqual([]);
  });
});
