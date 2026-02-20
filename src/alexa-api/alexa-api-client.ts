/**
 * HTTP client for the unofficial Alexa Web API.
 *
 * Uses Node's built-in `https` module with cookie-based authentication.
 * No external dependencies.
 */

import https from 'https';
import { URL } from 'url';
import type {
  AlexaApiRegion,
  AlexaCookieCredentials,
  RawSmartHomeEntity,
  RawEchoDevice,
  RawDeviceGroup,
  AccountDevice,
  AccountDeviceCommand,
} from './alexa-api-types';
import { ALEXA_API_BASE_URLS } from './alexa-api-types';

interface HttpResponse {
  statusCode: number;
  data: string;
  headers: Record<string, string | string[] | undefined>;
}

export class AlexaApiClient {
  private baseUrl: string;
  private credentials: AlexaCookieCredentials | null = null;

  constructor(region: AlexaApiRegion = 'NA') {
    this.baseUrl = ALEXA_API_BASE_URLS[region];
  }

  // -----------------------------------------------------------------------
  // Credential management
  // -----------------------------------------------------------------------

  setCredentials(credentials: AlexaCookieCredentials): void {
    this.credentials = credentials;

    // Auto-extract CSRF from the cookie string if not explicitly set
    if (!credentials.csrf) {
      const csrfMatch = credentials.cookie.match(/csrf=([^;]+)/);
      if (csrfMatch) {
        this.credentials = { ...credentials, csrf: csrfMatch[1] };
      }
    }
  }

  getCredentials(): AlexaCookieCredentials | null {
    return this.credentials;
  }

  hasValidCredentials(): boolean {
    return this.credentials !== null && this.credentials.cookie.length > 0;
  }

  // -----------------------------------------------------------------------
  // API methods
  // -----------------------------------------------------------------------

  /**
   * Fetch all smart home entities (lights, plugs, thermostats, etc.).
   * GET /api/behaviors/entities?skillId=amzn1.ask.1p.smarthome
   */
  async getSmartHomeDevices(): Promise<RawSmartHomeEntity[]> {
    this.requireCredentials();
    const response = await this.request(
      'GET',
      '/api/behaviors/entities?skillId=amzn1.ask.1p.smarthome',
    );
    return this.parseJsonResponse(response);
  }

  /**
   * Fetch all Echo/media devices on the account.
   * GET /api/devices/device
   */
  async getEchoDevices(): Promise<RawEchoDevice[]> {
    this.requireCredentials();
    const response = await this.request('GET', '/api/devices/device');
    const data = this.parseJsonResponse(response);
    // The response wraps the device list in a `devices` field
    return (data as any).devices ?? data;
  }

  /**
   * Fetch device groups (rooms, etc.).
   * GET /api/phoenix/group
   */
  async getDeviceGroups(): Promise<RawDeviceGroup[]> {
    this.requireCredentials();
    const response = await this.request('GET', '/api/phoenix/group');
    const data = this.parseJsonResponse(response);
    return Array.isArray(data) ? data : [];
  }

  /**
   * Get ALL devices on the account, normalized into a unified shape.
   * Fetches smart home devices, Echo devices, and groups in parallel.
   */
  async getAllDevices(): Promise<AccountDevice[]> {
    const [smartHome, echoDevices, groups] = await Promise.all([
      this.getSmartHomeDevices().catch(() => [] as RawSmartHomeEntity[]),
      this.getEchoDevices().catch(() => [] as RawEchoDevice[]),
      this.getDeviceGroups().catch(() => [] as RawDeviceGroup[]),
    ]);

    // Build group membership index
    const groupMembership = new Map<string, string[]>();
    for (const group of groups) {
      for (const member of group.members ?? []) {
        const existing = groupMembership.get(member.id) ?? [];
        existing.push(group.groupName);
        groupMembership.set(member.id, existing);
      }
    }

    const devices = new Map<string, AccountDevice>();

    // Normalize smart home entities
    for (const entity of smartHome) {
      const id = entity.entityId;
      devices.set(id, {
        id,
        name: entity.friendlyName ?? id,
        source: 'smart_home',
        deviceType: entity.providerData?.categoryType ?? entity.entityType ?? 'UNKNOWN',
        online: entity.reachable ?? true,
        manufacturer: entity.providerData?.manufacturerName,
        model: entity.providerData?.modelName,
        skillId: entity.providerData?.skillId,
        capabilities: (entity.capabilities ?? []).map((c) => c.interfaceName),
        groups: groupMembership.get(id),
        raw: entity as unknown as Record<string, unknown>,
      });
    }

    // Normalize Echo devices
    for (const echo of echoDevices) {
      const id = echo.serialNumber;
      if (!devices.has(id)) {
        devices.set(id, {
          id,
          name: echo.accountName ?? echo.deviceTypeFriendlyName ?? id,
          source: 'echo',
          deviceType: echo.deviceFamily ?? echo.deviceType ?? 'ECHO',
          online: echo.online,
          manufacturer: 'Amazon',
          model: echo.deviceTypeFriendlyName,
          capabilities: echo.capabilities ?? [],
          groups: groupMembership.get(id),
          raw: echo as unknown as Record<string, unknown>,
        });
      }
    }

    return Array.from(devices.values());
  }

  /**
   * Send a command to a device via the behaviors/operation API.
   * POST /api/behaviors/operation
   */
  async sendCommand(params: {
    deviceId: string;
    deviceType: string;
    command: AccountDeviceCommand;
    ownerCustomerId?: string;
  }): Promise<void> {
    this.requireCredentials();

    const node = this.buildSequenceNode(params);
    const payload = JSON.stringify({
      behaviorId: 'PREVIEW',
      sequenceJson: JSON.stringify({
        '@type': 'com.amazon.alexa.behaviors.model.Sequence',
        startNode: node,
      }),
      status: 'ENABLED',
    });

    const response = await this.request('POST', '/api/behaviors/operation', payload);

    if (response.statusCode >= 400) {
      throw new Error(
        `Alexa command failed (${response.statusCode}): ${response.data}`,
      );
    }
  }

  /**
   * Verify the cookie is still valid by hitting a lightweight endpoint.
   */
  async validateCookie(): Promise<boolean> {
    if (!this.credentials?.cookie) return false;

    try {
      const response = await this.request('GET', '/api/bootstrap');
      // 200 or 2xx = valid; 302/401/403 = expired
      return response.statusCode >= 200 && response.statusCode < 300;
    } catch {
      return false;
    }
  }

  // -----------------------------------------------------------------------
  // Command → sequence node mapping
  // -----------------------------------------------------------------------

  private buildSequenceNode(params: {
    deviceId: string;
    deviceType: string;
    command: AccountDeviceCommand;
    ownerCustomerId?: string;
  }): Record<string, unknown> {
    const { deviceId, deviceType, command, ownerCustomerId } = params;

    const baseNode = {
      '@type': 'com.amazon.alexa.behaviors.model.OpaquePayloadOperationNode',
      operationPayload: {} as Record<string, unknown>,
    };

    const deviceTarget = {
      customerId: ownerCustomerId ?? '',
      deviceSerialNumber: deviceId,
      deviceType,
    };

    switch (command.action) {
      case 'turn_on':
        baseNode.operationPayload = {
          type: 'Alexa.DeviceControls.Power',
          deviceType,
          deviceSerialNumber: deviceId,
          action: 'turnOn',
        };
        break;

      case 'turn_off':
        baseNode.operationPayload = {
          type: 'Alexa.DeviceControls.Power',
          deviceType,
          deviceSerialNumber: deviceId,
          action: 'turnOff',
        };
        break;

      case 'set_brightness':
        baseNode.operationPayload = {
          type: 'Alexa.DeviceControls.Brightness',
          deviceType,
          deviceSerialNumber: deviceId,
          brightness: command.brightness,
        };
        break;

      case 'set_color':
        baseNode.operationPayload = {
          type: 'Alexa.DeviceControls.Color',
          deviceType,
          deviceSerialNumber: deviceId,
          colorName: undefined,
          hue: command.color.hue,
          saturation: command.color.saturation,
          brightness: command.color.brightness,
        };
        break;

      case 'set_color_temperature':
        baseNode.operationPayload = {
          type: 'Alexa.DeviceControls.ColorTemperature',
          deviceType,
          deviceSerialNumber: deviceId,
          colorTemperatureInKelvin: command.colorTemperatureInKelvin,
        };
        break;

      case 'set_volume':
        baseNode.operationPayload = {
          type: 'Alexa.DeviceControls.Volume',
          deviceType,
          deviceSerialNumber: deviceId,
          volumeLevel: command.volume,
        };
        break;

      case 'set_thermostat':
        baseNode.operationPayload = {
          type: 'Alexa.DeviceControls.ThermostatTemperature',
          deviceType,
          deviceSerialNumber: deviceId,
          targetTemperature: {
            value: command.targetSetpoint.value,
            scale: command.targetSetpoint.scale,
          },
          ...(command.mode ? { thermostatMode: command.mode.value } : {}),
        };
        break;

      case 'speak':
        baseNode.operationPayload = {
          type: 'Alexa.Speak',
          textToSpeak: command.text,
          target: deviceTarget,
        };
        break;

      case 'play':
        baseNode.operationPayload = {
          type: 'Alexa.Media.Play',
          deviceType,
          deviceSerialNumber: deviceId,
        };
        break;

      case 'pause':
        baseNode.operationPayload = {
          type: 'Alexa.Media.Pause',
          deviceType,
          deviceSerialNumber: deviceId,
        };
        break;

      case 'next':
        baseNode.operationPayload = {
          type: 'Alexa.Media.Next',
          deviceType,
          deviceSerialNumber: deviceId,
        };
        break;

      case 'previous':
        baseNode.operationPayload = {
          type: 'Alexa.Media.Previous',
          deviceType,
          deviceSerialNumber: deviceId,
        };
        break;

      default: {
        const _exhaustive: never = command;
        throw new Error(`Unknown command: ${(_exhaustive as AccountDeviceCommand).action}`);
      }
    }

    return baseNode;
  }

  // -----------------------------------------------------------------------
  // Internal HTTP helper
  // -----------------------------------------------------------------------

  private requireCredentials(): void {
    if (!this.credentials?.cookie) {
      throw new Error(
        'No Alexa cookie configured. Use the set_alexa_cookie action first. ' +
        'Extract your cookie from browser dev tools at alexa.amazon.com.',
      );
    }
  }

  private parseJsonResponse(response: HttpResponse): any {
    if (response.statusCode === 401 || response.statusCode === 403) {
      throw new Error(
        'Alexa cookie expired or invalid. Use set_alexa_cookie to provide a fresh cookie. ' +
        'Open alexa.amazon.com in your browser, copy the Cookie header from dev tools.',
      );
    }

    // Amazon sometimes returns 302 redirects to the login page
    if (response.statusCode >= 300 && response.statusCode < 400) {
      throw new Error(
        'Alexa cookie expired (received redirect to login). ' +
        'Use set_alexa_cookie to provide a fresh cookie.',
      );
    }

    if (response.statusCode >= 400) {
      throw new Error(
        `Alexa API error (${response.statusCode}): ${response.data.substring(0, 200)}`,
      );
    }

    try {
      return JSON.parse(response.data);
    } catch {
      throw new Error(
        'Alexa API returned non-JSON response. The cookie may be expired. ' +
        'Use set_alexa_cookie to provide a fresh cookie.',
      );
    }
  }

  /** Low-level HTTPS request, mirroring the pattern in LwaOAuthClient. */
  private request(method: string, path: string, body?: string): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.baseUrl);

      const headers: Record<string, string> = {
        Cookie: this.credentials!.cookie,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        Accept: 'application/json',
        'Accept-Language': 'en-US',
        Origin: this.baseUrl,
        Referer: `${this.baseUrl}/spa/index.html`,
      };

      if (this.credentials!.csrf) {
        headers['csrf'] = this.credentials!.csrf;
      }

      if (body) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = String(Buffer.byteLength(body));
      }

      const req = https.request(
        {
          hostname: url.hostname,
          port: 443,
          path: url.pathname + url.search,
          method,
          headers,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk: string) => (data += chunk));
          res.on('end', () => {
            resolve({
              statusCode: res.statusCode ?? 500,
              data,
              headers: res.headers as Record<string, string | string[] | undefined>,
            });
          });
        },
      );

      req.on('error', reject);

      if (body) {
        req.write(body);
      }

      req.end();
    });
  }
}
