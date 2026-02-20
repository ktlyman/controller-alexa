import { RoutineManager, InMemoryRoutineStore } from '../../src/routines';
import { loadConfig } from '../../src/config';
import type { RoutineDefinition } from '../../src/types/agent';

describe('RoutineManager', () => {
  let manager: RoutineManager;
  let store: InMemoryRoutineStore;
  const config = loadConfig({ skillId: 'test-skill-id' });

  beforeEach(() => {
    store = new InMemoryRoutineStore();
    manager = new RoutineManager(config, store);
  });

  const sampleRoutine: RoutineDefinition = {
    name: 'Bedtime',
    trigger: { type: 'schedule', cron: '0 22 * * *' },
    actions: [
      {
        type: 'device_command',
        endpointId: 'light-bedroom',
        command: { action: 'turn_off' },
      },
      {
        type: 'device_command',
        endpointId: 'thermostat-1',
        command: {
          action: 'set_thermostat',
          targetSetpoint: { value: 68, scale: 'FAHRENHEIT' },
        },
        delaySeconds: 5,
      },
    ],
  };

  it('should create a routine and return its ID', async () => {
    const id = await manager.createRoutine(sampleRoutine);
    expect(id).toBeTruthy();
    expect(typeof id).toBe('string');
  });

  it('should list routines', async () => {
    await manager.createRoutine(sampleRoutine);
    await manager.createRoutine({ ...sampleRoutine, name: 'Morning' });

    const routines = await manager.listRoutines();
    expect(routines).toHaveLength(2);
    expect(routines[0].name).toBe('Bedtime');
    expect(routines[1].name).toBe('Morning');
  });

  it('should return routine summaries with correct fields', async () => {
    await manager.createRoutine(sampleRoutine);
    const [summary] = await manager.listRoutines();

    expect(summary.name).toBe('Bedtime');
    expect(summary.trigger).toEqual({ type: 'schedule', cron: '0 22 * * *' });
    expect(summary.actionCount).toBe(2);
    expect(summary.enabled).toBe(true);
    expect(summary.createdAt).toBeTruthy();
  });

  it('should get a routine by ID', async () => {
    const id = await manager.createRoutine(sampleRoutine);
    const routine = await manager.getRoutine(id);

    expect(routine).not.toBeNull();
    expect(routine!.name).toBe('Bedtime');
    expect(routine!.actions).toHaveLength(2);
  });

  it('should return null for nonexistent routine', async () => {
    const routine = await manager.getRoutine('nonexistent');
    expect(routine).toBeNull();
  });

  it('should trigger a routine and update lastTriggered', async () => {
    const id = await manager.createRoutine(sampleRoutine);

    const result = await manager.triggerRoutine(id);
    expect(result.triggered).toBe(true);
    expect(result.actionsToExecute).toHaveLength(2);

    const routine = await manager.getRoutine(id);
    expect(routine!.lastTriggered).toBeTruthy();
  });

  it('should throw when triggering nonexistent routine', async () => {
    await expect(manager.triggerRoutine('nonexistent')).rejects.toThrow(
      'Routine nonexistent not found',
    );
  });

  it('should delete a routine', async () => {
    const id = await manager.createRoutine(sampleRoutine);
    const deleted = await manager.deleteRoutine(id);
    expect(deleted).toBe(true);

    const routine = await manager.getRoutine(id);
    expect(routine).toBeNull();
  });

  it('should return false when deleting nonexistent routine', async () => {
    const deleted = await manager.deleteRoutine('nonexistent');
    expect(deleted).toBe(false);
  });
});
