/**
 * Client for the Alexa Event Gateway.
 *
 * Sends proactive events (ChangeReport, AddOrUpdateReport, etc.)
 * to Alexa on behalf of a user.
 */

import https from 'https';
import { v4 as uuid } from 'uuid';
import type {
  AlexaRegion,
  AlexaMessage,
  AlexaPropertyState,
  ChangeCause,
} from '../types/alexa';
import { EVENT_GATEWAY_URLS } from '../types/alexa';

export class EventGatewayClient {
  private endpoint: string;

  constructor(region: AlexaRegion) {
    this.endpoint = EVENT_GATEWAY_URLS[region];
  }

  /**
   * Send a ChangeReport to the Alexa Event Gateway.
   *
   * Reports that one or more properties on a device have changed.
   * Alexa expects this within 3 seconds of a state change.
   */
  async sendChangeReport(params: {
    accessToken: string;
    endpointId: string;
    changedProperties: AlexaPropertyState[];
    contextProperties: AlexaPropertyState[];
    cause: ChangeCause;
  }): Promise<void> {
    const message: AlexaMessage = {
      event: {
        header: {
          namespace: 'Alexa',
          name: 'ChangeReport',
          messageId: uuid(),
          payloadVersion: '3',
        },
        endpoint: {
          endpointId: params.endpointId,
          scope: { type: 'BearerToken', token: params.accessToken },
        },
        payload: {
          change: {
            cause: { type: params.cause },
            properties: params.changedProperties,
          },
        },
      },
      context: {
        properties: params.contextProperties,
      },
    };

    await this.sendEvent(message, params.accessToken);
  }

  /**
   * Send an AddOrUpdateReport to proactively inform Alexa about
   * new or updated devices.
   */
  async sendAddOrUpdateReport(params: {
    accessToken: string;
    endpoints: Array<{
      endpointId: string;
      friendlyName: string;
      capabilities: unknown[];
    }>;
  }): Promise<void> {
    const message: AlexaMessage = {
      event: {
        header: {
          namespace: 'Alexa.Discovery',
          name: 'AddOrUpdateReport',
          messageId: uuid(),
          payloadVersion: '3',
        },
        payload: {
          endpoints: params.endpoints,
          scope: { type: 'BearerToken', token: params.accessToken },
        },
      },
    };

    await this.sendEvent(message, params.accessToken);
  }

  /**
   * Send a DeleteReport to inform Alexa that devices have been removed.
   */
  async sendDeleteReport(params: {
    accessToken: string;
    endpointIds: string[];
  }): Promise<void> {
    const message: AlexaMessage = {
      event: {
        header: {
          namespace: 'Alexa.Discovery',
          name: 'DeleteReport',
          messageId: uuid(),
          payloadVersion: '3',
        },
        payload: {
          endpoints: params.endpointIds.map((id) => ({ endpointId: id })),
          scope: { type: 'BearerToken', token: params.accessToken },
        },
      },
    };

    await this.sendEvent(message, params.accessToken);
  }

  /**
   * Send an arbitrary event to the Event Gateway.
   */
  async sendEvent(message: AlexaMessage, accessToken: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(message);
      const url = new URL(this.endpoint);

      const req = https.request(
        {
          hostname: url.hostname,
          port: 443,
          path: url.pathname,
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk: string) => (data += chunk));
          res.on('end', () => {
            // Event Gateway returns 202 Accepted on success
            if (res.statusCode === 202) {
              resolve();
            } else {
              reject(
                new Error(
                  `Event Gateway returned ${res.statusCode}: ${data}`,
                ),
              );
            }
          });
        },
      );

      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }
}
