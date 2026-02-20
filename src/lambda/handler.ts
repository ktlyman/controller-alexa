/**
 * AWS Lambda handler for the Alexa Smart Home Skill.
 *
 * This is the entry point that Alexa invokes when a user issues a
 * voice command or when the skill needs to discover devices.
 *
 * The handler:
 * 1. Receives Alexa directives (Discover, TurnOn, ReportState, etc.)
 * 2. Logs every directive/response through the EventLogger
 * 3. Delegates to the appropriate controller
 * 4. Returns the Alexa-formatted response
 */

import { v4 as uuid } from 'uuid';
import type { AlexaMessage, DiscoveredDevice, AcceptGrantPayload } from '../types/alexa';
import { AuthManager } from '../auth';
import { DeviceController, DeviceRegistry } from '../devices';
import { EventLogger } from '../events';
import type { AlexaAgentConfig } from '../config';

export interface LambdaContext {
  functionName: string;
  functionVersion: string;
  invokedFunctionArn: string;
  memoryLimitInMB: string;
  awsRequestId: string;
  logGroupName: string;
  logStreamName: string;
  getRemainingTimeInMillis: () => number;
}

/**
 * Create the Lambda handler function with injected dependencies.
 */
export function createHandler(deps: {
  config: AlexaAgentConfig;
  auth: AuthManager;
  deviceRegistry: DeviceRegistry;
  deviceController: DeviceController;
  eventLogger: EventLogger;
  /**
   * Callback to resolve a device directive.
   * In a real system this would talk to the actual IoT device.
   * For the agent tool, this is where device backends plug in.
   */
  onDeviceDirective?: (message: AlexaMessage) => Promise<AlexaMessage>;
  /**
   * Callback to provide the list of devices for discovery.
   */
  onDiscover?: (bearerToken: string) => Promise<DiscoveredDevice[]>;
}) {
  const { auth, deviceRegistry, deviceController, eventLogger, onDeviceDirective, onDiscover } = deps;

  return async function handler(
    event: AlexaMessage,
    _context?: LambdaContext,
  ): Promise<AlexaMessage> {
    const directive = event.directive;
    if (!directive) {
      return buildErrorResponse('INVALID_DIRECTIVE', 'No directive in request');
    }

    const { namespace, name } = directive.header;

    // Log the incoming directive
    await eventLogger.logAlexaMessage(event, directive.endpoint?.scope?.userId);

    try {
      let response: AlexaMessage;

      switch (namespace) {
        case 'Alexa.Authorization':
          response = await handleAcceptGrant(directive.payload as unknown as AcceptGrantPayload);
          break;

        case 'Alexa.Discovery':
          response = await handleDiscover(directive.endpoint?.scope?.token ?? '');
          break;

        case 'Alexa':
          if (name === 'ReportState') {
            response = await handleReportState(event);
          } else {
            response = buildErrorResponse('INVALID_DIRECTIVE', `Unsupported Alexa directive: ${name}`);
          }
          break;

        default:
          // All other namespaces are device control directives
          response = await handleDeviceControl(event);
          break;
      }

      // Log the outgoing response
      await eventLogger.logAlexaMessage(response, directive.endpoint?.scope?.userId);

      return response;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return buildErrorResponse('INTERNAL_ERROR', message);
    }
  };

  // -----------------------------------------------------------------------
  // Directive handlers
  // -----------------------------------------------------------------------

  async function handleAcceptGrant(payload: AcceptGrantPayload): Promise<AlexaMessage> {
    const { code } = payload.grant;
    const userId = payload.grantee.token;

    await auth.handleAcceptGrant(userId, code);

    return {
      event: {
        header: {
          namespace: 'Alexa.Authorization',
          name: 'AcceptGrant.Response',
          messageId: uuid(),
          payloadVersion: '3',
        },
        payload: {},
      },
    };
  }

  async function handleDiscover(bearerToken: string): Promise<AlexaMessage> {
    let devices: DiscoveredDevice[] = [];

    if (onDiscover) {
      devices = await onDiscover(bearerToken);
    }

    deviceRegistry.setAll(devices);

    return {
      event: {
        header: {
          namespace: 'Alexa.Discovery',
          name: 'Discover.Response',
          messageId: uuid(),
          payloadVersion: '3',
        },
        payload: {
          endpoints: devices,
        },
      },
    };
  }

  async function handleReportState(event: AlexaMessage): Promise<AlexaMessage> {
    if (onDeviceDirective) {
      return onDeviceDirective(event);
    }
    // Default: return empty state
    return {
      event: {
        header: {
          namespace: 'Alexa',
          name: 'StateReport',
          messageId: uuid(),
          correlationToken: event.directive?.header.correlationToken,
          payloadVersion: '3',
        },
        endpoint: event.directive?.endpoint,
        payload: {},
      },
      context: { properties: [] },
    };
  }

  async function handleDeviceControl(event: AlexaMessage): Promise<AlexaMessage> {
    if (onDeviceDirective) {
      const response = await onDeviceDirective(event);
      return response;
    }

    // Default acknowledgment
    return {
      event: {
        header: {
          namespace: 'Alexa',
          name: 'Response',
          messageId: uuid(),
          correlationToken: event.directive?.header.correlationToken,
          payloadVersion: '3',
        },
        endpoint: event.directive?.endpoint,
        payload: {},
      },
      context: { properties: [] },
    };
  }
}

function buildErrorResponse(type: string, message: string): AlexaMessage {
  return {
    event: {
      header: {
        namespace: 'Alexa',
        name: 'ErrorResponse',
        messageId: uuid(),
        payloadVersion: '3',
      },
      payload: { type, message },
    },
  };
}
