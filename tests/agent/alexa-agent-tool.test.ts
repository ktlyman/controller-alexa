import { AlexaAgentTool } from '../../src/agent';
import { InMemoryEventStore } from '../../src/events';
import type { AgentAction } from '../../src/types/agent';

describe('AlexaAgentTool', () => {
  let tool: AlexaAgentTool;
  let eventStore: InMemoryEventStore;

  beforeEach(() => {
    eventStore = new InMemoryEventStore();
    tool = new AlexaAgentTool({
      config: {
        clientId: 'test-id',
        clientSecret: 'test-secret',
        region: 'NA',
        skillId: 'test-skill',
        storageBackend: 'memory',
      },
      userId: 'test-user',
      eventStore,
    });
  });

  describe('discover_devices', () => {
    it('should return empty device list when no devices are registered', async () => {
      const result = await tool.execute({ type: 'discover_devices' });
      expect(result.success).toBe(true);
      expect((result.data as any).devices).toEqual([]);
    });

    it('should log a discovery event', async () => {
      await tool.execute({ type: 'discover_devices' });
      const events = await eventStore.query({ eventType: 'AgentDiscoverDevices' });
      expect(events.events).toHaveLength(1);
    });

    it('should include metadata in the result', async () => {
      const result = await tool.execute({ type: 'discover_devices' });
      expect(result.metadata).toBeDefined();
      expect(result.metadata!.requestId).toBeTruthy();
      expect(result.metadata!.timestamp).toBeTruthy();
      expect(typeof result.metadata!.durationMs).toBe('number');
    });
  });

  describe('get_device_state', () => {
    it('should fail when device does not exist', async () => {
      const result = await tool.execute({
        type: 'get_device_state',
        endpointId: 'nonexistent',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('control_device', () => {
    it('should fail when device does not exist', async () => {
      const result = await tool.execute({
        type: 'control_device',
        endpointId: 'nonexistent',
        command: { action: 'turn_on' },
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should succeed when device exists in registry', async () => {
      // Seed the registry via the sub-module accessor
      tool.getDeviceRegistry().upsert({
        endpointId: 'light-1',
        manufacturerName: 'Test',
        description: 'Test Light',
        friendlyName: 'Living Room Light',
        displayCategories: ['LIGHT'],
        capabilities: [],
      });

      const result = await tool.execute({
        type: 'control_device',
        endpointId: 'light-1',
        command: { action: 'turn_on' },
      });
      expect(result.success).toBe(true);
      expect((result.data as any).acknowledged).toBe(true);
    });

    it('should log control events', async () => {
      tool.getDeviceRegistry().upsert({
        endpointId: 'light-1',
        manufacturerName: 'Test',
        description: 'Test Light',
        friendlyName: 'Test',
        displayCategories: ['LIGHT'],
        capabilities: [],
      });

      await tool.execute({
        type: 'control_device',
        endpointId: 'light-1',
        command: { action: 'turn_off' },
      });

      const events = await eventStore.query({ eventType: 'AgentControlDevice' });
      expect(events.events).toHaveLength(1);
      expect(events.events[0].tags).toContain('device_control');
    });
  });

  describe('routines', () => {
    it('should create and list routines', async () => {
      const createResult = await tool.execute({
        type: 'create_routine',
        routine: {
          name: 'Test Routine',
          trigger: { type: 'schedule', cron: '0 8 * * *' },
          actions: [
            {
              type: 'device_command',
              endpointId: 'light-1',
              command: { action: 'turn_on' },
            },
          ],
        },
      });
      expect(createResult.success).toBe(true);
      expect((createResult.data as any).routineId).toBeTruthy();

      const listResult = await tool.execute({ type: 'list_routines' });
      expect(listResult.success).toBe(true);
      expect((listResult.data as any).routines).toHaveLength(1);
      expect((listResult.data as any).routines[0].name).toBe('Test Routine');
    });

    it('should trigger a routine', async () => {
      const createResult = await tool.execute({
        type: 'create_routine',
        routine: {
          name: 'Quick Trigger',
          trigger: { type: 'custom', triggerId: 'trigger-1' },
          actions: [],
        },
      });
      const routineId = (createResult.data as any).routineId;

      const triggerResult = await tool.execute({
        type: 'trigger_routine',
        routineId,
      });
      expect(triggerResult.success).toBe(true);
      expect((triggerResult.data as any).triggered).toBe(true);
    });

    it('should delete a routine', async () => {
      const createResult = await tool.execute({
        type: 'create_routine',
        routine: {
          name: 'To Delete',
          trigger: { type: 'schedule', cron: '0 0 * * *' },
          actions: [],
        },
      });
      const routineId = (createResult.data as any).routineId;

      const deleteResult = await tool.execute({
        type: 'delete_routine',
        routineId,
      });
      expect(deleteResult.success).toBe(true);
      expect((deleteResult.data as any).deleted).toBe(true);

      const listResult = await tool.execute({ type: 'list_routines' });
      expect((listResult.data as any).routines).toHaveLength(0);
    });

    it('should fail to trigger nonexistent routine', async () => {
      const result = await tool.execute({
        type: 'trigger_routine',
        routineId: 'nonexistent',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('query_events', () => {
    it('should return logged events', async () => {
      // Generate some events by performing actions
      await tool.execute({ type: 'discover_devices' });
      await tool.execute({ type: 'discover_devices' });

      const result = await tool.execute({
        type: 'query_events',
        query: { eventType: 'AgentDiscoverDevices' },
      });

      expect(result.success).toBe(true);
      expect((result.data as any).events.length).toBeGreaterThanOrEqual(2);
    });

    it('should support pagination', async () => {
      // Generate multiple events
      for (let i = 0; i < 5; i++) {
        await tool.execute({ type: 'discover_devices' });
      }

      const result = await tool.execute({
        type: 'query_events',
        query: { eventType: 'AgentDiscoverDevices', limit: 2 },
      });

      expect(result.success).toBe(true);
      expect((result.data as any).events).toHaveLength(2);
      expect((result.data as any).totalCount).toBeGreaterThanOrEqual(5);
    });
  });

  describe('get_event_stream', () => {
    it('should return a stream subscription', async () => {
      const result = await tool.execute({
        type: 'get_event_stream',
        endpointIds: ['light-1'],
      });

      expect(result.success).toBe(true);
      expect((result.data as any).streamId).toBeTruthy();
      expect((result.data as any).status).toBe('subscribed');
    });
  });

  describe('error handling', () => {
    it('should return error result on failure', async () => {
      const result = await tool.execute({
        type: 'get_device_state',
        endpointId: 'nonexistent',
      });
      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
      expect(result.metadata).toBeDefined();
    });
  });

  describe('sub-module accessors', () => {
    it('should expose auth manager', () => {
      expect(tool.getAuth()).toBeDefined();
    });

    it('should expose device registry', () => {
      expect(tool.getDeviceRegistry()).toBeDefined();
    });

    it('should expose device controller', () => {
      expect(tool.getDeviceController()).toBeDefined();
    });

    it('should expose routine manager', () => {
      expect(tool.getRoutineManager()).toBeDefined();
    });

    it('should expose event logger', () => {
      expect(tool.getEventLogger()).toBeDefined();
    });

    it('should expose event gateway', () => {
      expect(tool.getEventGateway()).toBeDefined();
    });
  });
});
