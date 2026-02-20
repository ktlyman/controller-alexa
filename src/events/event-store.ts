/**
 * Event store — persists Alexa events for historical querying.
 *
 * Alexa does NOT store event history, so we capture every directive,
 * response, and change report that flows through our system and make
 * it queryable.
 */

export interface StoredEvent {
  id: string;
  /** ISO-8601 timestamp */
  timestamp: string;
  /** The event type / Alexa directive name */
  eventType: string;
  /** Alexa interface namespace (e.g., Alexa.PowerController) */
  namespace: string;
  /** Target device endpoint ID (if applicable) */
  endpointId?: string;
  /** Associated user ID */
  userId?: string;
  /** What triggered this event */
  cause?: string;
  /** Full event payload (serialized JSON) */
  payload: Record<string, unknown>;
  /** Optional tags for filtering */
  tags?: string[];
}

export interface EventQuery {
  /** Filter by endpoint ID */
  endpointId?: string;
  /** Filter by user ID */
  userId?: string;
  /** Filter by event type */
  eventType?: string;
  /** Filter by namespace */
  namespace?: string;
  /** Start of time range (ISO-8601) */
  startTime?: string;
  /** End of time range (ISO-8601) */
  endTime?: string;
  /** Maximum number of results */
  limit?: number;
  /** Pagination cursor (event ID to start after) */
  cursor?: string;
  /** Filter by tags (AND logic) */
  tags?: string[];
}

export interface EventQueryResult {
  events: StoredEvent[];
  totalCount: number;
  cursor?: string;
}

export interface EventStore {
  insert(event: StoredEvent): Promise<void>;
  insertBatch(events: StoredEvent[]): Promise<void>;
  query(query: EventQuery): Promise<EventQueryResult>;
  getById(id: string): Promise<StoredEvent | null>;
  count(query?: Partial<EventQuery>): Promise<number>;
  /** Remove events older than the given ISO-8601 timestamp */
  prune(olderThan: string): Promise<number>;
}

/**
 * In-memory event store for development and testing.
 * Events are stored in a sorted array (newest first).
 */
export class InMemoryEventStore implements EventStore {
  private events: StoredEvent[] = [];
  private maxEvents: number;

  constructor(maxEvents = 10_000) {
    this.maxEvents = maxEvents;
  }

  async insert(event: StoredEvent): Promise<void> {
    this.events.unshift(event);
    if (this.events.length > this.maxEvents) {
      this.events.length = this.maxEvents;
    }
  }

  async insertBatch(events: StoredEvent[]): Promise<void> {
    for (const e of events) {
      await this.insert(e);
    }
  }

  async query(query: EventQuery): Promise<EventQueryResult> {
    let filtered = this.events;

    if (query.endpointId) {
      filtered = filtered.filter((e) => e.endpointId === query.endpointId);
    }
    if (query.userId) {
      filtered = filtered.filter((e) => e.userId === query.userId);
    }
    if (query.eventType) {
      filtered = filtered.filter((e) => e.eventType === query.eventType);
    }
    if (query.namespace) {
      filtered = filtered.filter((e) => e.namespace === query.namespace);
    }
    if (query.startTime) {
      filtered = filtered.filter((e) => e.timestamp >= query.startTime!);
    }
    if (query.endTime) {
      filtered = filtered.filter((e) => e.timestamp <= query.endTime!);
    }
    if (query.tags && query.tags.length > 0) {
      filtered = filtered.filter((e) =>
        query.tags!.every((tag) => e.tags?.includes(tag)),
      );
    }

    const totalCount = filtered.length;

    // Cursor-based pagination: skip until we find the cursor event
    if (query.cursor) {
      const idx = filtered.findIndex((e) => e.id === query.cursor);
      if (idx >= 0) {
        filtered = filtered.slice(idx + 1);
      }
    }

    const limit = query.limit ?? 100;
    const page = filtered.slice(0, limit);
    const nextCursor = page.length === limit ? page[page.length - 1].id : undefined;

    return { events: page, totalCount, cursor: nextCursor };
  }

  async getById(id: string): Promise<StoredEvent | null> {
    return this.events.find((e) => e.id === id) ?? null;
  }

  async count(query?: Partial<EventQuery>): Promise<number> {
    if (!query) return this.events.length;
    const result = await this.query(query as EventQuery);
    return result.totalCount;
  }

  async prune(olderThan: string): Promise<number> {
    const before = this.events.length;
    this.events = this.events.filter((e) => e.timestamp >= olderThan);
    return before - this.events.length;
  }
}
