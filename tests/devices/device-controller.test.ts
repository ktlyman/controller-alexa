import { DeviceController, DeviceRegistry } from '../../src/devices';
import type { DeviceCommand } from '../../src/types/agent';

describe('DeviceController', () => {
  let controller: DeviceController;
  let registry: DeviceRegistry;
  const token = 'Atza|test-token';

  beforeEach(() => {
    registry = new DeviceRegistry();
    controller = new DeviceController(registry);
  });

  describe('buildDirective', () => {
    const testCases: Array<{
      name: string;
      command: DeviceCommand;
      expectedNamespace: string;
      expectedName: string;
    }> = [
      {
        name: 'turn_on',
        command: { action: 'turn_on' },
        expectedNamespace: 'Alexa.PowerController',
        expectedName: 'TurnOn',
      },
      {
        name: 'turn_off',
        command: { action: 'turn_off' },
        expectedNamespace: 'Alexa.PowerController',
        expectedName: 'TurnOff',
      },
      {
        name: 'set_brightness',
        command: { action: 'set_brightness', brightness: 75 },
        expectedNamespace: 'Alexa.BrightnessController',
        expectedName: 'SetBrightness',
      },
      {
        name: 'set_color',
        command: { action: 'set_color', color: { hue: 120, saturation: 1, brightness: 1 } },
        expectedNamespace: 'Alexa.ColorController',
        expectedName: 'SetColor',
      },
      {
        name: 'set_color_temperature',
        command: { action: 'set_color_temperature', colorTemperatureInKelvin: 4000 },
        expectedNamespace: 'Alexa.ColorTemperatureController',
        expectedName: 'SetColorTemperature',
      },
      {
        name: 'set_thermostat',
        command: {
          action: 'set_thermostat',
          targetSetpoint: { value: 72, scale: 'FAHRENHEIT' },
        },
        expectedNamespace: 'Alexa.ThermostatController',
        expectedName: 'SetTargetTemperature',
      },
      {
        name: 'lock',
        command: { action: 'lock' },
        expectedNamespace: 'Alexa.LockController',
        expectedName: 'Lock',
      },
      {
        name: 'unlock',
        command: { action: 'unlock' },
        expectedNamespace: 'Alexa.LockController',
        expectedName: 'Unlock',
      },
      {
        name: 'set_volume',
        command: { action: 'set_volume', volume: 50 },
        expectedNamespace: 'Alexa.Speaker',
        expectedName: 'SetVolume',
      },
      {
        name: 'set_mute',
        command: { action: 'set_mute', mute: true },
        expectedNamespace: 'Alexa.Speaker',
        expectedName: 'SetMute',
      },
      {
        name: 'set_percentage',
        command: { action: 'set_percentage', percentage: 80 },
        expectedNamespace: 'Alexa.PercentageController',
        expectedName: 'SetPercentage',
      },
      {
        name: 'activate_scene',
        command: { action: 'activate_scene' },
        expectedNamespace: 'Alexa.SceneController',
        expectedName: 'Activate',
      },
      {
        name: 'deactivate_scene',
        command: { action: 'deactivate_scene' },
        expectedNamespace: 'Alexa.SceneController',
        expectedName: 'Deactivate',
      },
    ];

    for (const tc of testCases) {
      it(`should build correct directive for ${tc.name}`, () => {
        const msg = controller.buildDirective('endpoint-1', tc.command, token);

        expect(msg.directive).toBeDefined();
        expect(msg.directive!.header.namespace).toBe(tc.expectedNamespace);
        expect(msg.directive!.header.name).toBe(tc.expectedName);
        expect(msg.directive!.header.payloadVersion).toBe('3');
        expect(msg.directive!.header.messageId).toBeTruthy();
        expect(msg.directive!.endpoint?.endpointId).toBe('endpoint-1');
        expect(msg.directive!.endpoint?.scope?.token).toBe(token);
      });
    }

    it('should include brightness in payload for set_brightness', () => {
      const msg = controller.buildDirective(
        'ep-1',
        { action: 'set_brightness', brightness: 42 },
        token,
      );
      expect((msg.directive!.payload as any).brightness).toBe(42);
    });

    it('should include thermostat mode when provided', () => {
      const msg = controller.buildDirective(
        'ep-1',
        {
          action: 'set_thermostat',
          targetSetpoint: { value: 20, scale: 'CELSIUS' },
          mode: { value: 'HEAT' },
        },
        token,
      );
      expect((msg.directive!.payload as any).thermostatMode).toEqual({ value: 'HEAT' });
    });
  });

  describe('buildReportStateDirective', () => {
    it('should build a ReportState directive', () => {
      const msg = controller.buildReportStateDirective('ep-1', token);
      expect(msg.directive!.header.namespace).toBe('Alexa');
      expect(msg.directive!.header.name).toBe('ReportState');
      expect(msg.directive!.endpoint?.endpointId).toBe('ep-1');
    });
  });

  describe('parseStateReport', () => {
    it('should parse a StateReport response', () => {
      const msg = {
        event: {
          header: {
            namespace: 'Alexa' as const,
            name: 'StateReport',
            messageId: 'msg-1',
            payloadVersion: '3' as const,
          },
          endpoint: { endpointId: 'ep-1' },
          payload: {},
        },
        context: {
          properties: [
            {
              namespace: 'Alexa.PowerController',
              name: 'powerState',
              value: 'ON',
              timeOfSample: '2024-01-01T00:00:00Z',
              uncertaintyInMilliseconds: 0,
            },
          ],
        },
      };

      const state = controller.parseStateReport(msg);
      expect(state).not.toBeNull();
      expect(state!.endpointId).toBe('ep-1');
      expect(state!.properties).toHaveLength(1);
      expect(state!.properties[0].value).toBe('ON');
    });

    it('should return null for non-StateReport messages', () => {
      const msg = {
        event: {
          header: {
            namespace: 'Alexa' as const,
            name: 'Response',
            messageId: 'msg-1',
            payloadVersion: '3' as const,
          },
          payload: {},
        },
      };
      expect(controller.parseStateReport(msg)).toBeNull();
    });
  });
});
