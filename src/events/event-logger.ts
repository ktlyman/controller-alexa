/**
 * Event logger — captures Alexa messages and persists them for
 * real-time streaming and historical queries.
 *
 * The logger acts as an observer: any module in the system can call
 * `log()` to record an event.  Subscribers receive real-time
 * notifications via the listener API.
 */

import { v4 as uuid } from 'uuid';
import type { AlexaMessage, AlexaPropertyState, ChangeCause } from '../types/alexa';
import type { EventStore, StoredEvent } from './event-store';
import { InMemoryEventStore } from './event-store';

export type EventListener = (event: StoredEvent) => void;

export class EventLogger {
  private store: EventStore;
  private listeners = new Map<string, EventListener>();
  private streamFilters = new Map<string, Set<string> | null>(); // streamId -> endpointIds (null = all)

  constructor(store?: EventStore) {
    this.store = store ?? new InMemoryEventStore();
  }

  /**
   * Log a raw Alexa message (directive or event).
   * Extracts structured metadata and persists it.
   */
  async logAlexaMessage(message: AlexaMessage, userId?: string): Promise<StoredEvent> {
    const header = message.directive?.header ?? message.event?.header;
    const endpoint = message.directive?.endpoint ?? message.event?.endpoint;
    const payload = message.directive?.payload ?? message.event?.payload ?? {};

    if (!header) {
      throw new Error('Cannot log a message with no header');
    }

    const event: StoredEvent = {
      id: uuid(),
      timestamp: new Date().toISOString(),
      eventType: header.name,
      namespace: header.namespace,
      endpointId: endpoint?.endpointId,
      userId,
      cause: this.extractCause(payload),
      payload: payload as Record<string, unknown>,
      tags: this.deriveTags(header.namespace, header.name),
    };

    await this.store.insert(event);
    this.notifyListeners(event);
    return event;
  }

  /**
   * Log a custom event (not directly from an Alexa message).
   */
  async logCustomEvent(params: {
    eventType: string;
    namespace: string;
    endpointId?: string;
    userId?: string;
    cause?: string;
    payload?: Record<string, unknown>;
    tags?: string[];
  }): Promise<StoredEvent> {
    const event: StoredEvent = {
      id: uuid(),
      timestamp: new Date().toISOString(),
      eventType: params.eventType,
      namespace: params.namespace,
      endpointId: params.endpointId,
      userId: params.userId,
      cause: params.cause,
      payload: params.payload ?? {},
      tags: params.tags,
    };

    await this.store.insert(event);
    this.notifyListeners(event);
    return event;
  }

  /**
   * Log a property state change (from ChangeReport or StateReport).
   */
  async logPropertyChange(
    endpointId: string,
    properties: AlexaPropertyState[],
    cause?: ChangeCause,
    userId?: string,
  ): Promise<StoredEvent[]> {
    const events: StoredEvent[] = [];
    for (const prop of properties) {
      const event: StoredEvent = {
        id: uuid(),
        timestamp: prop.timeOfSample || new Date().toISOString(),
        eventType: 'PropertyChange',
        namespace: prop.namespace,
        endpointId,
        userId,
        cause,
        payload: { name: prop.name, value: prop.value },
        tags: ['state_change'],
      };
      await this.store.insert(event);
      this.notifyListeners(event);
      events.push(event);
    }
    return events;
  }

  /**
   * Subscribe to real-time events.
   *
   * @param endpointIds If provided, only events for these endpoints are delivered.
   *                    If empty/undefined, all events are delivered.
   * @returns A stream ID that can be used to unsubscribe.
   */
  subscribe(listener: EventListener, endpointIds?: string[]): string {
    const streamId = uuid();
    this.listeners.set(streamId, listener);
    this.streamFilters.set(
      streamId,
      endpointIds && endpointIds.length > 0 ? new Set(endpointIds) : null,
    );
    return streamId;
  }

  /**
   * Unsubscribe from real-time events.
   */
  unsubscribe(streamId: string): void {
    this.listeners.delete(streamId);
    this.streamFilters.delete(streamId);
  }

  /**
   * Get the underlying event store for direct queries.
   */
  getStore(): EventStore {
    return this.store;
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private notifyListeners(event: StoredEvent): void {
    for (const [streamId, listener] of this.listeners) {
      const filter = this.streamFilters.get(streamId);
      if (filter === null || (event.endpointId && filter?.has(event.endpointId))) {
        try {
          listener(event);
        } catch {
          // Don't let a failing listener break other listeners
        }
      }
    }
  }

  private extractCause(payload: unknown): string | undefined {
    if (typeof payload === 'object' && payload !== null) {
      const p = payload as Record<string, unknown>;
      const change = p['change'] as Record<string, unknown> | undefined;
      if (change?.cause) {
        const cause = change.cause as Record<string, unknown>;
        return cause.type as string;
      }
    }
    return undefined;
  }

  private deriveTags(namespace: string, name: string): string[] {
    const tags: string[] = [];
    if (name === 'TurnOn' || name === 'TurnOff') tags.push('power');
    if (namespace.includes('Brightness')) tags.push('brightness');
    if (namespace.includes('Color')) tags.push('color');
    if (namespace.includes('Thermostat')) tags.push('thermostat');
    if (namespace.includes('Lock')) tags.push('lock');
    if (namespace.includes('Scene')) tags.push('scene');
    if (namespace.includes('Speaker')) tags.push('audio');
    if (name === 'ChangeReport') tags.push('state_change');
    if (name === 'Discover' || name === 'Discover.Response') tags.push('discovery');
    return tags;
  }
}
