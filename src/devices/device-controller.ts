/**
 * Device controller — builds Smart Home directives and sends them
 * through the Event Gateway or processes them locally in Lambda.
 *
 * This module translates high-level agent commands (turn_on, set_brightness,
 * etc.) into Alexa Smart Home API v3 directives.
 */

import { v4 as uuid } from 'uuid';
import type {
  AlexaDirective,
  AlexaMessage,
  AlexaPropertyState,
  DeviceState,
} from '../types/alexa';
import type { DeviceCommand } from '../types/agent';
import { DeviceRegistry } from './device-registry';

export class DeviceController {
  constructor(private registry: DeviceRegistry) {}

  /**
   * Build an Alexa directive message for the given device command.
   * The caller is responsible for dispatching this directive
   * (either via Lambda invocation or the Event Gateway).
   */
  buildDirective(endpointId: string, command: DeviceCommand, bearerToken: string): AlexaMessage {
    const { namespace, name, payload } = this.mapCommandToDirective(command);

    const directive: AlexaDirective = {
      header: {
        namespace,
        name,
        messageId: uuid(),
        correlationToken: uuid(),
        payloadVersion: '3',
      },
      endpoint: {
        endpointId,
        scope: { type: 'BearerToken', token: bearerToken },
      },
      payload: payload ?? {},
    };

    return { directive };
  }

  /**
   * Build a ReportState directive to query a device's current state.
   */
  buildReportStateDirective(endpointId: string, bearerToken: string): AlexaMessage {
    return {
      directive: {
        header: {
          namespace: 'Alexa',
          name: 'ReportState',
          messageId: uuid(),
          correlationToken: uuid(),
          payloadVersion: '3',
        },
        endpoint: {
          endpointId,
          scope: { type: 'BearerToken', token: bearerToken },
        },
        payload: {},
      },
    };
  }

  /**
   * Parse a StateReport response into a DeviceState.
   */
  parseStateReport(message: AlexaMessage): DeviceState | null {
    const event = message.event;
    if (!event || event.header.name !== 'StateReport') return null;

    const properties: AlexaPropertyState[] = [
      ...(message.context?.properties ?? []),
    ];

    return {
      endpointId: event.endpoint?.endpointId ?? '',
      properties,
      retrievedAt: new Date().toISOString(),
    };
  }

  /**
   * Map a high-level DeviceCommand to the Alexa directive namespace/name/payload.
   */
  private mapCommandToDirective(command: DeviceCommand): {
    namespace: string;
    name: string;
    payload?: Record<string, unknown>;
  } {
    switch (command.action) {
      case 'turn_on':
        return { namespace: 'Alexa.PowerController', name: 'TurnOn' };
      case 'turn_off':
        return { namespace: 'Alexa.PowerController', name: 'TurnOff' };
      case 'set_brightness':
        return {
          namespace: 'Alexa.BrightnessController',
          name: 'SetBrightness',
          payload: { brightness: command.brightness },
        };
      case 'set_color':
        return {
          namespace: 'Alexa.ColorController',
          name: 'SetColor',
          payload: { color: command.color },
        };
      case 'set_color_temperature':
        return {
          namespace: 'Alexa.ColorTemperatureController',
          name: 'SetColorTemperature',
          payload: { colorTemperatureInKelvin: command.colorTemperatureInKelvin },
        };
      case 'set_thermostat':
        return {
          namespace: 'Alexa.ThermostatController',
          name: 'SetTargetTemperature',
          payload: {
            targetSetpoint: command.targetSetpoint,
            ...(command.mode ? { thermostatMode: command.mode } : {}),
          },
        };
      case 'lock':
        return { namespace: 'Alexa.LockController', name: 'Lock' };
      case 'unlock':
        return { namespace: 'Alexa.LockController', name: 'Unlock' };
      case 'set_volume':
        return {
          namespace: 'Alexa.Speaker',
          name: 'SetVolume',
          payload: { volume: command.volume },
        };
      case 'set_mute':
        return {
          namespace: 'Alexa.Speaker',
          name: 'SetMute',
          payload: { mute: command.mute },
        };
      case 'set_percentage':
        return {
          namespace: 'Alexa.PercentageController',
          name: 'SetPercentage',
          payload: { percentage: command.percentage },
        };
      case 'activate_scene':
        return {
          namespace: 'Alexa.SceneController',
          name: 'Activate',
        };
      case 'deactivate_scene':
        return {
          namespace: 'Alexa.SceneController',
          name: 'Deactivate',
        };
      default:
        throw new Error(`Unknown device command action: ${(command as DeviceCommand).action}`);
    }
  }
}
