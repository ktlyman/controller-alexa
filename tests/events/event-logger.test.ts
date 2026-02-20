import { EventLogger, InMemoryEventStore } from '../../src/events';
import type { StoredEvent } from '../../src/events';
import type { AlexaMessage } from '../../src/types/alexa';

describe('EventLogger', () => {
  let logger: EventLogger;
  let store: InMemoryEventStore;

  beforeEach(() => {
    store = new InMemoryEventStore();
    logger = new EventLogger(store);
  });

  describe('logAlexaMessage', () => {
    it('should log a directive message', async () => {
      const msg: AlexaMessage = {
        directive: {
          header: {
            namespace: 'Alexa.PowerController',
            name: 'TurnOn',
            messageId: 'msg-1',
            payloadVersion: '3',
          },
          endpoint: { endpointId: 'light-1' },
          payload: {},
        },
      };

      const event = await logger.logAlexaMessage(msg, 'user-1');

      expect(event.eventType).toBe('TurnOn');
      expect(event.namespace).toBe('Alexa.PowerController');
      expect(event.endpointId).toBe('light-1');
      expect(event.userId).toBe('user-1');
      expect(event.tags).toContain('power');
    });

    it('should log an event message', async () => {
      const msg: AlexaMessage = {
        event: {
          header: {
            namespace: 'Alexa',
            name: 'ChangeReport',
            messageId: 'msg-2',
            payloadVersion: '3',
          },
          endpoint: { endpointId: 'thermo-1' },
          payload: {
            change: {
              cause: { type: 'PHYSICAL_INTERACTION' },
              properties: [],
            },
          },
        },
      };

      const event = await logger.logAlexaMessage(msg);
      expect(event.eventType).toBe('ChangeReport');
      expect(event.cause).toBe('PHYSICAL_INTERACTION');
      expect(event.tags).toContain('state_change');
    });

    it('should throw for messages with no header', async () => {
      await expect(logger.logAlexaMessage({} as AlexaMessage)).rejects.toThrow(
        'Cannot log a message with no header',
      );
    });
  });

  describe('logCustomEvent', () => {
    it('should log a custom event', async () => {
      const event = await logger.logCustomEvent({
        eventType: 'AgentAction',
        namespace: 'AlexaAgentTool',
        userId: 'user-1',
        payload: { action: 'discover' },
        tags: ['agent'],
      });

      expect(event.eventType).toBe('AgentAction');
      expect(event.namespace).toBe('AlexaAgentTool');
      expect(event.tags).toContain('agent');
    });
  });

  describe('logPropertyChange', () => {
    it('should log individual property changes', async () => {
      const properties = [
        {
          namespace: 'Alexa.PowerController',
          name: 'powerState',
          value: 'ON',
          timeOfSample: '2024-01-01T00:00:00Z',
          uncertaintyInMilliseconds: 0,
        },
        {
          namespace: 'Alexa.BrightnessController',
          name: 'brightness',
          value: 75,
          timeOfSample: '2024-01-01T00:00:00Z',
          uncertaintyInMilliseconds: 0,
        },
      ];

      const events = await logger.logPropertyChange('light-1', properties, 'VOICE_INTERACTION', 'user-1');
      expect(events).toHaveLength(2);
      expect(events[0].eventType).toBe('PropertyChange');
      expect(events[0].payload).toEqual({ name: 'powerState', value: 'ON' });
      expect(events[1].payload).toEqual({ name: 'brightness', value: 75 });
    });
  });

  describe('real-time subscriptions', () => {
    it('should deliver events to subscribers', async () => {
      const received: StoredEvent[] = [];
      logger.subscribe((event) => received.push(event));

      await logger.logCustomEvent({
        eventType: 'Test',
        namespace: 'Test',
        endpointId: 'ep-1',
      });

      expect(received).toHaveLength(1);
      expect(received[0].eventType).toBe('Test');
    });

    it('should filter events by endpoint ID', async () => {
      const received: StoredEvent[] = [];
      logger.subscribe((event) => received.push(event), ['ep-1']);

      await logger.logCustomEvent({
        eventType: 'Test',
        namespace: 'Test',
        endpointId: 'ep-1',
      });
      await logger.logCustomEvent({
        eventType: 'Test',
        namespace: 'Test',
        endpointId: 'ep-2',
      });

      expect(received).toHaveLength(1);
      expect(received[0].endpointId).toBe('ep-1');
    });

    it('should allow unsubscribing', async () => {
      const received: StoredEvent[] = [];
      const streamId = logger.subscribe((event) => received.push(event));

      await logger.logCustomEvent({ eventType: 'Before', namespace: 'Test', endpointId: 'ep-1' });
      logger.unsubscribe(streamId);
      await logger.logCustomEvent({ eventType: 'After', namespace: 'Test', endpointId: 'ep-1' });

      expect(received).toHaveLength(1);
      expect(received[0].eventType).toBe('Before');
    });

    it('should not break other listeners when one throws', async () => {
      const received: StoredEvent[] = [];

      logger.subscribe(() => { throw new Error('boom'); });
      logger.subscribe((event) => received.push(event));

      await logger.logCustomEvent({
        eventType: 'Test',
        namespace: 'Test',
        endpointId: 'ep-1',
      });

      expect(received).toHaveLength(1);
    });
  });

  describe('getStore', () => {
    it('should return the underlying event store', () => {
      expect(logger.getStore()).toBe(store);
    });
  });
});
