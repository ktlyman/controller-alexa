/**
 * Push event storage abstraction for real-time events received
 * via the Alexa WebSocket push channel.
 *
 * Mirrors the DeviceStateStore / ActivityStore pattern.
 */

import type { StoredPushEvent } from './push-event-types';

// ---------------------------------------------------------------------------
// Query types
// ---------------------------------------------------------------------------

export interface PushEventQuery {
  command?: string;
  deviceSerial?: string;
  startTime?: string;   // ISO-8601
  endTime?: string;     // ISO-8601
  processed?: boolean;
  limit?: number;
  offset?: number;
}

export interface PushEventQueryResult {
  events: StoredPushEvent[];
  totalCount: number;
}

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

export interface PushEventStore {
  insert(event: StoredPushEvent): Promise<void>;
  insertBatch(events: StoredPushEvent[]): Promise<void>;
  query(query: PushEventQuery): Promise<PushEventQueryResult>;
  getById(id: string): Promise<StoredPushEvent | null>;
  markProcessed(id: string): Promise<void>;
  prune(olderThan: string): Promise<number>;
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

export class InMemoryPushEventStore implements PushEventStore {
  private events: StoredPushEvent[] = [];
  private maxEvents: number;

  constructor(maxEvents = 10_000) {
    this.maxEvents = maxEvents;
  }

  async insert(event: StoredPushEvent): Promise<void> {
    // Dedup by id
    if (!this.events.some((e) => e.id === event.id)) {
      this.events.unshift(event);
      if (this.events.length > this.maxEvents) {
        this.events.length = this.maxEvents;
      }
    }
  }

  async insertBatch(events: StoredPushEvent[]): Promise<void> {
    for (const e of events) {
      await this.insert(e);
    }
  }

  async query(query: PushEventQuery): Promise<PushEventQueryResult> {
    let filtered = this.events;

    if (query.command) {
      filtered = filtered.filter((e) => e.command === query.command);
    }
    if (query.deviceSerial) {
      filtered = filtered.filter((e) => e.deviceSerial === query.deviceSerial);
    }
    if (query.startTime) {
      filtered = filtered.filter((e) => e.timestamp >= query.startTime!);
    }
    if (query.endTime) {
      filtered = filtered.filter((e) => e.timestamp <= query.endTime!);
    }
    if (query.processed !== undefined) {
      filtered = filtered.filter((e) => e.processed === query.processed);
    }

    const totalCount = filtered.length;
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 100;

    return { events: filtered.slice(offset, offset + limit), totalCount };
  }

  async getById(id: string): Promise<StoredPushEvent | null> {
    return this.events.find((e) => e.id === id) ?? null;
  }

  async markProcessed(id: string): Promise<void> {
    const event = this.events.find((e) => e.id === id);
    if (event) {
      event.processed = true;
    }
  }

  async prune(olderThan: string): Promise<number> {
    const before = this.events.length;
    this.events = this.events.filter((e) => e.timestamp >= olderThan);
    return before - this.events.length;
  }
}
