/**
 * Device state storage abstraction for polled state snapshots.
 *
 * Mirrors the CookieStore / EventStore pattern — an interface plus
 * a lightweight in-memory implementation for dev and testing.
 */

import type { DeviceStateSnapshot } from './alexa-api-types';

// ---------------------------------------------------------------------------
// Query types
// ---------------------------------------------------------------------------

export interface DeviceStateQuery {
  deviceId?: string;
  startTime?: string; // ISO-8601
  endTime?: string;   // ISO-8601
  limit?: number;
  offset?: number;
}

export interface DeviceStateQueryResult {
  snapshots: DeviceStateSnapshot[];
  totalCount: number;
}

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

export interface DeviceStateStore {
  insert(snapshot: DeviceStateSnapshot): Promise<void>;
  insertBatch(snapshots: DeviceStateSnapshot[]): Promise<void>;
  query(query: DeviceStateQuery): Promise<DeviceStateQueryResult>;
  getLatest(deviceId: string): Promise<DeviceStateSnapshot | null>;
  prune(olderThan: string): Promise<number>;
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

export class InMemoryDeviceStateStore implements DeviceStateStore {
  private snapshots: DeviceStateSnapshot[] = [];
  private maxSnapshots: number;

  constructor(maxSnapshots = 10_000) {
    this.maxSnapshots = maxSnapshots;
  }

  async insert(snapshot: DeviceStateSnapshot): Promise<void> {
    this.snapshots.unshift(snapshot);
    if (this.snapshots.length > this.maxSnapshots) {
      this.snapshots.length = this.maxSnapshots;
    }
  }

  async insertBatch(snapshots: DeviceStateSnapshot[]): Promise<void> {
    for (const s of snapshots) {
      await this.insert(s);
    }
  }

  async query(query: DeviceStateQuery): Promise<DeviceStateQueryResult> {
    let filtered = this.snapshots;

    if (query.deviceId) {
      filtered = filtered.filter((s) => s.deviceId === query.deviceId);
    }
    if (query.startTime) {
      filtered = filtered.filter((s) => s.polledAt >= query.startTime!);
    }
    if (query.endTime) {
      filtered = filtered.filter((s) => s.polledAt <= query.endTime!);
    }

    const totalCount = filtered.length;
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 100;
    const page = filtered.slice(offset, offset + limit);

    return { snapshots: page, totalCount };
  }

  async getLatest(deviceId: string): Promise<DeviceStateSnapshot | null> {
    return this.snapshots.find((s) => s.deviceId === deviceId) ?? null;
  }

  async prune(olderThan: string): Promise<number> {
    const before = this.snapshots.length;
    this.snapshots = this.snapshots.filter((s) => s.polledAt >= olderThan);
    return before - this.snapshots.length;
  }
}
