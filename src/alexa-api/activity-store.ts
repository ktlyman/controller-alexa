/**
 * Activity history storage abstraction.
 *
 * Stores voice interaction records fetched from Amazon's
 * customer-history-records API for local querying.
 */

import type { ActivityRecord } from './alexa-api-types';

// ---------------------------------------------------------------------------
// Query types
// ---------------------------------------------------------------------------

export interface ActivityQuery {
  deviceSerial?: string;
  startTime?: string;   // ISO-8601
  endTime?: string;     // ISO-8601
  searchText?: string;  // text search in utterance/response
  limit?: number;
  offset?: number;
}

export interface ActivityQueryResult {
  records: ActivityRecord[];
  totalCount: number;
}

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

export interface ActivityStore {
  insert(record: ActivityRecord): Promise<void>;
  insertBatch(records: ActivityRecord[]): Promise<void>;
  query(query: ActivityQuery): Promise<ActivityQueryResult>;
  getById(id: string): Promise<ActivityRecord | null>;
  prune(olderThan: string): Promise<number>;
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

export class InMemoryActivityStore implements ActivityStore {
  private records: ActivityRecord[] = [];
  private maxRecords: number;

  constructor(maxRecords = 10_000) {
    this.maxRecords = maxRecords;
  }

  async insert(record: ActivityRecord): Promise<void> {
    // Deduplicate by id
    if (!this.records.some((r) => r.id === record.id)) {
      this.records.unshift(record);
      if (this.records.length > this.maxRecords) {
        this.records.length = this.maxRecords;
      }
    }
  }

  async insertBatch(records: ActivityRecord[]): Promise<void> {
    for (const r of records) {
      await this.insert(r);
    }
  }

  async query(query: ActivityQuery): Promise<ActivityQueryResult> {
    let filtered = this.records;

    if (query.deviceSerial) {
      filtered = filtered.filter((r) => r.deviceSerial === query.deviceSerial);
    }
    if (query.startTime) {
      filtered = filtered.filter((r) => r.timestamp >= query.startTime!);
    }
    if (query.endTime) {
      filtered = filtered.filter((r) => r.timestamp <= query.endTime!);
    }
    if (query.searchText) {
      const lower = query.searchText.toLowerCase();
      filtered = filtered.filter(
        (r) =>
          r.utteranceText?.toLowerCase().includes(lower) ||
          r.responseText?.toLowerCase().includes(lower),
      );
    }

    const totalCount = filtered.length;
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 100;

    return { records: filtered.slice(offset, offset + limit), totalCount };
  }

  async getById(id: string): Promise<ActivityRecord | null> {
    return this.records.find((r) => r.id === id) ?? null;
  }

  async prune(olderThan: string): Promise<number> {
    const before = this.records.length;
    this.records = this.records.filter((r) => r.timestamp >= olderThan);
    return before - this.records.length;
  }
}
