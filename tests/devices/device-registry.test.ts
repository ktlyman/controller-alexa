import { DeviceRegistry } from '../../src/devices';
import type { DiscoveredDevice } from '../../src/types/alexa';

function makeDevice(id: string, category: 'LIGHT' | 'THERMOSTAT' = 'LIGHT'): DiscoveredDevice {
  return {
    endpointId: id,
    manufacturerName: 'TestCo',
    description: `Test ${category}`,
    friendlyName: `${category} ${id}`,
    displayCategories: [category],
    capabilities: [
      {
        type: 'AlexaInterface',
        interface: 'Alexa.PowerController',
        version: '3',
        properties: {
          supported: [{ name: 'powerState' }],
          proactivelyReported: true,
          retrievable: true,
        },
      },
    ],
  };
}

describe('DeviceRegistry', () => {
  let registry: DeviceRegistry;

  beforeEach(() => {
    registry = new DeviceRegistry();
  });

  it('should start empty', () => {
    expect(registry.size).toBe(0);
    expect(registry.list()).toEqual([]);
  });

  it('should set all devices at once', () => {
    const devices = [makeDevice('d1'), makeDevice('d2'), makeDevice('d3')];
    registry.setAll(devices);
    expect(registry.size).toBe(3);
    expect(registry.list()).toHaveLength(3);
  });

  it('should get a device by endpoint ID', () => {
    registry.setAll([makeDevice('d1')]);
    expect(registry.get('d1')?.friendlyName).toBe('LIGHT d1');
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('should filter by display category', () => {
    registry.setAll([
      makeDevice('light-1', 'LIGHT'),
      makeDevice('thermo-1', 'THERMOSTAT'),
      makeDevice('light-2', 'LIGHT'),
    ]);
    expect(registry.list('LIGHT')).toHaveLength(2);
    expect(registry.list('THERMOSTAT')).toHaveLength(1);
    expect(registry.list('LOCK' as any)).toHaveLength(0);
  });

  it('should upsert a device', () => {
    registry.setAll([makeDevice('d1')]);
    const updated = makeDevice('d1');
    updated.friendlyName = 'Updated Light';
    registry.upsert(updated);
    expect(registry.size).toBe(1);
    expect(registry.get('d1')?.friendlyName).toBe('Updated Light');
  });

  it('should add a new device via upsert', () => {
    registry.setAll([makeDevice('d1')]);
    registry.upsert(makeDevice('d2'));
    expect(registry.size).toBe(2);
  });

  it('should remove a device', () => {
    registry.setAll([makeDevice('d1'), makeDevice('d2')]);
    expect(registry.remove('d1')).toBe(true);
    expect(registry.size).toBe(1);
    expect(registry.has('d1')).toBe(false);
  });

  it('should return false when removing nonexistent device', () => {
    expect(registry.remove('nonexistent')).toBe(false);
  });

  it('should check device existence with has()', () => {
    registry.setAll([makeDevice('d1')]);
    expect(registry.has('d1')).toBe(true);
    expect(registry.has('d2')).toBe(false);
  });

  it('should clear previous devices when setAll is called again', () => {
    registry.setAll([makeDevice('d1'), makeDevice('d2')]);
    registry.setAll([makeDevice('d3')]);
    expect(registry.size).toBe(1);
    expect(registry.has('d1')).toBe(false);
    expect(registry.has('d3')).toBe(true);
  });
});
