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
  GraphQLEndpointItem,
  AccountDevice,
  AccountDeviceCommand,
  DeviceStateSnapshot,
  ParsedCapabilityState,
  PhoenixStateResponse,
  ActivityRecord,
  ActivityHistoryResponse,
  RangeCapabilityConfig,
} from './alexa-api-types';
import { ALEXA_API_BASE_URLS } from './alexa-api-types';

// ---------------------------------------------------------------------------
// GraphQL query for all smart home endpoints (the modern Alexa app approach)
// ---------------------------------------------------------------------------
const ENDPOINTS_GRAPHQL_QUERY = `query Endpoints {
  endpoints {
    items {
      endpointId
      id
      friendlyName
      displayCategories {
        primary {
          value
        }
      }
      legacyAppliance {
        applianceId
        applianceTypes
        endpointTypeId
        friendlyName
        friendlyDescription
        manufacturerName
        connectedVia
        modelName
        entityId
        actions
        capabilities
        applianceNetworkState
        isEnabled
        additionalApplianceDetails
      }
      serialNumber {
        value {
          text
        }
      }
      enablement
      model {
        value {
          text
        }
      }
      manufacturer {
        value {
          text
        }
      }
      features {
        name
        operations {
          name
        }
      }
    }
  }
}`;

interface HttpResponse {
  statusCode: number;
  data: string;
  headers: Record<string, string | string[] | undefined>;
}

export class AlexaApiClient {
  private baseUrl: string;
  private credentials: AlexaCookieCredentials | null = null;
  private cachedCustomerId: string | null = null;

  constructor(region: AlexaApiRegion = 'NA') {
    this.baseUrl = ALEXA_API_BASE_URLS[region];
  }

  // -----------------------------------------------------------------------
  // Credential management
  // -----------------------------------------------------------------------

  setCredentials(credentials: AlexaCookieCredentials): void {
    this.credentials = credentials;
    this.cachedCustomerId = null; // Reset on credential change

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

  /**
   * Fetch the Amazon customer ID for the authenticated account.
   * Caches the result so subsequent calls don't make additional requests.
   * Required for behaviors/preview command payloads.
   */
  async getCustomerId(): Promise<string> {
    if (this.cachedCustomerId) return this.cachedCustomerId;

    this.requireCredentials();
    try {
      const response = await this.request('GET', '/api/bootstrap');
      if (response.statusCode >= 200 && response.statusCode < 300) {
        const data = JSON.parse(response.data);
        const id = data?.authentication?.customerId;
        if (id) {
          this.cachedCustomerId = id;
          return id;
        }
      }
    } catch {
      // Fall through to empty string
    }

    return '';
  }

  // -----------------------------------------------------------------------
  // API methods
  // -----------------------------------------------------------------------

  /**
   * Fetch ALL smart home endpoints via the GraphQL API.
   * POST /nexus/v1/graphql
   *
   * This is the modern endpoint used by the Alexa mobile app and returns
   * every smart home device (lights, plugs, thermostats, sensors, locks, etc.)
   * — not just the subset available in routines.
   */
  async getSmartHomeEndpoints(): Promise<GraphQLEndpointItem[]> {
    this.requireCredentials();
    const body = JSON.stringify({ query: ENDPOINTS_GRAPHQL_QUERY });
    const response = await this.request('POST', '/nexus/v1/graphql', body);
    const data = this.parseJsonResponse(response);
    return data?.data?.endpoints?.items ?? [];
  }

  /**
   * Fetch smart home entities from the behaviors/entities endpoint.
   * GET /api/behaviors/entities?skillId=amzn1.ask.1p.smarthome
   *
   * NOTE: This only returns devices configured as routine triggers — a small
   * subset. Prefer getSmartHomeEndpoints() for the full list.
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
   *
   * Uses the GraphQL endpoint (primary) + Echo REST API + groups in parallel.
   * The GraphQL endpoint returns every smart home device; the REST endpoint
   * adds Echo/media devices that the GraphQL query doesn't include.
   */
  async getAllDevices(): Promise<AccountDevice[]> {
    const [endpoints, echoDevices, groups] = await Promise.all([
      this.getSmartHomeEndpoints().catch(() => [] as GraphQLEndpointItem[]),
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

    // Index to detect when a GraphQL endpoint is really an Echo device.
    // GraphQL returns Echo devices as ALEXA_VOICE_ENABLED endpoints with their
    // own endpoint ID, while the Echo REST API returns them by serial number.
    // We use the serial number from GraphQL to merge both records into one.
    const serialToEndpointId = new Map<string, string>();

    // Normalize GraphQL endpoints (smart home devices, including lights, plugs, etc.)
    for (const ep of endpoints) {
      const id = ep.id ?? ep.endpointId;
      const category = ep.displayCategories?.primary?.value ?? 'UNKNOWN';
      const legacy = ep.legacyAppliance;

      // Skip meta-endpoints that aren't real controllable devices:
      // - "This Device": routing alias for the currently-active Echo
      // - SCENE_TRIGGER: virtual scene activators, not physical devices
      // - ACTIVITY_TRIGGER: routine/activity triggers
      // - WHA: Whole Home Audio groups (managed separately)
      const name = ep.friendlyName ?? legacy?.friendlyName ?? '';
      if (name === 'This Device' || name === 'this device') continue;
      const HIDDEN_CATEGORIES = ['SCENE_TRIGGER', 'ACTIVITY_TRIGGER', 'WHA'];
      if (HIDDEN_CATEGORIES.includes(category)) continue;
      const reachability = legacy?.applianceNetworkState?.reachability;

      // Track serial → endpoint mapping for Echo device dedup
      const serial = ep.serialNumber?.value?.text;
      if (serial) {
        serialToEndpointId.set(serial, id);
      }

      // Extract feature names for capabilities
      const featureOps: string[] = [];
      for (const f of ep.features ?? []) {
        for (const op of f.operations ?? []) {
          featureOps.push(op.name);
        }
      }

      // Extract Alexa Smart Home interface names from legacy capabilities
      // (e.g., "Alexa.PowerController", "Alexa.ContactSensor", "Alexa.LockController")
      const interfaces: string[] = [];
      const rangeCapabilities: RangeCapabilityConfig[] = [];
      for (const cap of (legacy as Record<string, unknown>)?.capabilities as Array<{ interfaceName?: string; type?: string; instance?: string; configuration?: Record<string, unknown> }> ?? []) {
        const iface = cap.interfaceName ?? (cap as Record<string, unknown>).interface as string | undefined;
        if (iface && !interfaces.includes(iface)) {
          interfaces.push(iface);
        }

        // Extract RangeController configuration (min/max/step/unit per instance)
        if (iface === 'Alexa.RangeController' && cap.instance && cap.configuration) {
          const supportedRange = cap.configuration.supportedRange as { minimumValue?: number; maximumValue?: number; precision?: number } | undefined;
          const unitOfMeasure = cap.configuration.unitOfMeasure as string | undefined;

          // Extract semantic name from resources.friendlyNames
          // Can be an assetId like "Alexa.AirQuality.Humidity" or plain text like "Particulate matter PM10"
          let friendlyName: string | undefined;
          const capAny = cap as Record<string, unknown>;
          const resources = capAny.resources as { friendlyNames?: Array<{ value?: { assetId?: string; text?: string }; '@type'?: string }> } | undefined;
          if (resources?.friendlyNames?.[0]) {
            const fn = resources.friendlyNames[0];
            friendlyName = fn.value?.assetId ?? fn.value?.text;
          }

          if (supportedRange) {
            rangeCapabilities.push({
              instance: cap.instance,
              minimumValue: supportedRange.minimumValue,
              maximumValue: supportedRange.maximumValue,
              precision: supportedRange.precision,
              unitOfMeasure: unitOfMeasure,
              friendlyName,
            });
          }
        }
      }

      devices.set(id, {
        id,
        name: ep.friendlyName ?? legacy?.friendlyName ?? id,
        source: 'smart_home',
        deviceType: category,
        online: reachability === 'REACHABLE' || (reachability == null && ep.enablement === 'ENABLED'),
        manufacturer: ep.manufacturer?.value?.text ?? legacy?.manufacturerName,
        model: ep.model?.value?.text ?? legacy?.modelName,
        capabilities: featureOps.length > 0
          ? featureOps
          : (legacy?.actions ?? []),
        interfaces,
        description: legacy?.friendlyDescription,
        groups: groupMembership.get(id) ?? groupMembership.get(legacy?.applianceId ?? ''),
        entityId: legacy?.entityId,
        applianceId: legacy?.applianceId,
        rangeCapabilities: rangeCapabilities.length > 0 ? rangeCapabilities : undefined,
        raw: ep as unknown as Record<string, unknown>,
      });
    }

    // Hidden Echo device families — not real controllable devices:
    // VOX = "This Device" alias, WHA = Whole Home Audio group,
    // THIRD_PARTY_AVS_SONOS_BOOTLEG/etc = phantom entries
    const HIDDEN_ECHO_FAMILIES = ['VOX', 'WHA', 'THIRD_PARTY_AVS_SONOS_BOOTLEG'];
    const HIDDEN_ECHO_NAMES = ['This Device', 'this device'];

    // Normalize Echo devices — merge into existing GraphQL entry when possible,
    // otherwise add as a new device.
    for (const echo of echoDevices) {
      const id = echo.serialNumber;
      const family = echo.deviceFamily ?? '';
      const echoName = echo.accountName ?? echo.deviceTypeFriendlyName ?? '';

      // Skip hidden devices
      if (HIDDEN_ECHO_FAMILIES.includes(family)) continue;
      if (HIDDEN_ECHO_NAMES.includes(echoName)) continue;

      const existingEndpointId = serialToEndpointId.get(id);

      if (existingEndpointId && devices.has(existingEndpointId)) {
        // This Echo device already appeared in GraphQL as an ALEXA_VOICE_ENABLED
        // endpoint. Merge Echo-specific data into the existing entry so we get
        // one device with both the smart-home entityId AND the Echo serial/type.
        const existing = devices.get(existingEndpointId)!;
        existing.source = 'echo';
        existing.deviceType = echo.deviceFamily ?? existing.deviceType;
        existing.alexaDeviceType = echo.deviceType;
        existing.online = echo.online;
        existing.model = existing.model ?? echo.deviceTypeFriendlyName;
        // Use the serial number as ID so commands route correctly
        devices.delete(existingEndpointId);
        existing.id = id;
        devices.set(id, existing);
      } else if (!devices.has(id)) {
        devices.set(id, {
          id,
          name: echo.accountName ?? echo.deviceTypeFriendlyName ?? id,
          source: 'echo',
          // deviceFamily ('ECHO', 'KNIGHT') is the display category;
          // echo.deviceType ('A3S5BH2HU6VAYF') is the product code needed by the API
          deviceType: echo.deviceFamily ?? 'ECHO',
          alexaDeviceType: echo.deviceType,
          online: echo.online,
          manufacturer: 'Amazon',
          model: echo.deviceTypeFriendlyName,
          capabilities: echo.capabilities ?? [],
          interfaces: [],
          description: echo.deviceTypeFriendlyName,
          groups: groupMembership.get(id),
          raw: echo as unknown as Record<string, unknown>,
        });
      }
    }

    return Array.from(devices.values());
  }

  /**
   * Send a command to a device via the behaviors/preview API.
   * POST /api/behaviors/preview
   */
  async sendCommand(params: {
    deviceId: string;
    deviceType: string;
    command: AccountDeviceCommand;
    ownerCustomerId?: string;
  }): Promise<void> {
    this.requireCredentials();

    // Auto-fetch customerId if not provided
    const ownerCustomerId = params.ownerCustomerId || await this.getCustomerId();
    const node = this.buildSequenceNode({ ...params, ownerCustomerId });
    const payload = JSON.stringify({
      behaviorId: 'PREVIEW',
      sequenceJson: JSON.stringify({
        '@type': 'com.amazon.alexa.behaviors.model.Sequence',
        startNode: node,
      }),
      status: 'ENABLED',
    });

    const response = await this.request('POST', '/api/behaviors/preview', payload);

    if (response.statusCode >= 400) {
      throw new Error(
        `Alexa command failed (${response.statusCode}): ${response.data}`,
      );
    }
  }

  /**
   * Send a command to a smart home device via the behaviors/preview API
   * using the Alexa.SmartHome.Batch format.
   *
   * This works for smart home devices (lights, plugs, thermostats, etc.)
   * that are identified by entity IDs, as opposed to `sendCommand()` which
   * only works for Echo devices identified by serial numbers.
   *
   * POST /api/behaviors/preview
   */
  async sendSmartHomeCommand(params: {
    entityId: string;
    command: AccountDeviceCommand;
    ownerCustomerId?: string;
  }): Promise<void> {
    this.requireCredentials();

    const operations = this.mapCommandToSmartHomeOperations(params.command);
    if (!operations) {
      throw new Error(
        `Command '${params.command.action}' is not supported for smart home devices. ` +
        `Only power, brightness, color, color temperature, thermostat, and volume are supported.`,
      );
    }

    // Auto-fetch customerId if not provided
    const customerId = params.ownerCustomerId || await this.getCustomerId();

    const node = {
      '@type': 'com.amazon.alexa.behaviors.model.OpaquePayloadOperationNode',
      type: 'Alexa.SmartHome.Batch',
      skillId: 'amzn1.ask.1p.smarthome',
      operationPayload: {
        target: params.entityId,
        customerId,
        operations,
        name: null,
      },
    };

    const payload = JSON.stringify({
      behaviorId: 'PREVIEW',
      sequenceJson: JSON.stringify({
        '@type': 'com.amazon.alexa.behaviors.model.Sequence',
        startNode: node,
      }),
      status: 'ENABLED',
    });

    const response = await this.request('POST', '/api/behaviors/preview', payload);

    if (response.statusCode >= 400) {
      throw new Error(
        `Alexa smart home command failed (${response.statusCode}): ${response.data}`,
      );
    }
  }

  /**
   * Map an AccountDeviceCommand to the Alexa.SmartHome.Batch operations array.
   * Returns null if the command is not supported for smart home devices.
   */
  private mapCommandToSmartHomeOperations(
    command: AccountDeviceCommand,
  ): Array<Record<string, unknown>> | null {
    switch (command.action) {
      case 'turn_on':
        return [{ type: 'turnOn' }];
      case 'turn_off':
        return [{ type: 'turnOff' }];
      case 'set_brightness':
        return [{ type: 'setBrightness', brightness: command.brightness }];
      case 'set_color':
        return [{ type: 'setColor', hue: command.color.hue, saturation: command.color.saturation, brightness: command.color.brightness }];
      case 'set_color_temperature':
        return [{ type: 'setColorTemperature', colorTemperatureInKelvin: command.colorTemperatureInKelvin }];
      case 'set_volume':
        return [{ type: 'setVolume', volumeLevel: command.volume }];
      case 'set_thermostat':
        return [{
          type: 'setTargetTemperature',
          targetTemperature: {
            value: command.targetSetpoint.value,
            scale: command.targetSetpoint.scale,
          },
          ...(command.mode ? { thermostatMode: command.mode.value } : {}),
        }];
      // speak, play, pause, next, previous are Echo-only commands
      case 'speak':
      case 'play':
      case 'pause':
      case 'next':
      case 'previous':
        return null;
      default:
        return null;
    }
  }

  /**
   * Poll device states via the phoenix/state API.
   * POST /api/phoenix/state
   *
   * The applianceIds must be `legacyAppliance.applianceId` values from GraphQL —
   * NOT the entityId (UUID) or endpointId (amzn1.alexa.endpoint...), which both
   * return TargetApplianceNotFoundException.
   *
   * @param applianceIds  The applianceId values to poll
   * @param deviceNameMap Optional map from applianceId → display name
   */
  async getDeviceStates(
    applianceIds: string[],
    deviceNameMap?: Map<string, string>,
  ): Promise<DeviceStateSnapshot[]> {
    this.requireCredentials();

    const stateRequests = applianceIds.map((entityId) => ({
      entityId,
      entityType: 'APPLIANCE',
    }));

    const body = JSON.stringify({ stateRequests });
    const response = await this.request('POST', '/api/phoenix/state', body);
    const data = this.parseJsonResponse(response) as PhoenixStateResponse;

    const polledAt = new Date().toISOString();
    const snapshots: DeviceStateSnapshot[] = [];

    // Process successful device states
    for (const ds of data.deviceStates ?? []) {
      const deviceId = ds.entity?.entityId;
      if (!deviceId) continue;

      if (ds.error) {
        snapshots.push({
          deviceId,
          deviceName: deviceNameMap?.get(deviceId),
          capabilities: [],
          polledAt,
          error: `${ds.error.code}: ${ds.error.message ?? 'unknown'}`,
        });
        continue;
      }

      // capabilityStates are JSON-encoded strings that need double-parsing
      const capabilities: ParsedCapabilityState[] = [];
      for (const raw of ds.capabilityStates ?? []) {
        try {
          const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
          const cap: ParsedCapabilityState = {
            namespace: parsed.namespace ?? '',
            name: parsed.name ?? '',
            value: parsed.value,
            timeOfSample: parsed.timeOfSample,
          };
          if (parsed.instance) {
            cap.instance = parsed.instance;
          }
          capabilities.push(cap);
        } catch {
          // Skip malformed capability states
        }
      }

      snapshots.push({
        deviceId,
        deviceName: deviceNameMap?.get(deviceId),
        capabilities,
        polledAt,
      });
    }

    // Process top-level errors (devices that couldn't be queried at all)
    for (const err of data.errors ?? []) {
      const deviceId = err.entity?.entityId;
      if (!deviceId) continue;
      // Skip "not found" errors silently — these are expected for devices
      // that don't support state queries (e.g. Echo devices, buttons)
      if (err.code === 'TargetApplianceNotFoundException') continue;
      snapshots.push({
        deviceId,
        deviceName: deviceNameMap?.get(deviceId),
        capabilities: [],
        polledAt,
        error: `${err.code}: ${err.message ?? 'unknown'}`,
      });
    }

    return snapshots;
  }

  /**
   * Fetch voice activity history from the privacy endpoint.
   * POST https://www.amazon.com/alexa-privacy/apd/rvh/customer-history-records-v2
   *
   * Note: This endpoint lives on www.amazon.com, NOT alexa.amazon.com.
   */
  async getActivityHistory(params?: {
    startTimestamp?: number;
    endTimestamp?: number;
    maxRecordSize?: number;
    nextToken?: string;
  }): Promise<{ records: ActivityRecord[]; nextToken?: string }> {
    this.requireCredentials();

    const now = Date.now();
    const body = JSON.stringify({
      previousRequestToken: params?.nextToken ?? null,
      startTimestamp: params?.startTimestamp ?? now - 7 * 24 * 60 * 60 * 1000,
      endTimestamp: params?.endTimestamp ?? now,
      maxRecordSize: params?.maxRecordSize ?? 50,
    });

    const response = await this.request(
      'POST',
      '/alexa-privacy/apd/rvh/customer-history-records-v2',
      body,
      { baseUrl: 'https://www.amazon.com' },
    );

    // The privacy endpoint on www.amazon.com may return HTML instead of JSON
    // if the cookie doesn't cover the www.amazon.com domain. Provide a clear
    // error message instead of a generic JSON parse failure.
    if (response.statusCode >= 300) {
      const snippet = response.data.substring(0, 200);
      throw new Error(
        `Activity history endpoint returned ${response.statusCode}. ` +
        (response.data.includes('<html') || response.data.includes('<!DOCTYPE')
          ? 'Received HTML (likely a login redirect). The cookie may not cover www.amazon.com. '
            + 'Try re-extracting cookies after visiting www.amazon.com/alexa-privacy.'
          : snippet),
      );
    }

    let data: ActivityHistoryResponse;
    try {
      data = JSON.parse(response.data) as ActivityHistoryResponse;
    } catch {
      throw new Error(
        'Activity history returned non-JSON. The cookie may not cover www.amazon.com. '
        + `Response starts with: ${response.data.substring(0, 100)}`,
      );
    }

    const records: ActivityRecord[] = [];
    for (const entry of data.customerHistoryRecords ?? []) {
      // Extract utterance and response text from voice history items
      let utteranceText: string | undefined;
      let responseText: string | undefined;

      for (const item of entry.voiceHistoryRecordItems ?? []) {
        if (item.recordItemType === 'CUSTOMER_TRANSCRIPT' || item.recordItemType === 'ASR_REPLACEMENT_TEXT') {
          utteranceText = utteranceText ?? item.transcriptText;
        } else if (item.recordItemType === 'ALEXA_RESPONSE' || item.recordItemType === 'TTS_REPLACEMENT_TEXT') {
          responseText = responseText ?? item.transcriptText;
        }
      }

      records.push({
        id: entry.recordKey,
        timestamp: new Date(entry.creationTimestamp).toISOString(),
        deviceSerial: entry.device?.serialNumber,
        deviceName: entry.device?.deviceName,
        deviceType: entry.device?.deviceType,
        utteranceText,
        responseText,
        utteranceType: entry.utteranceType,
        raw: entry as unknown as Record<string, unknown>,
      });
    }

    return {
      records,
      nextToken: data.encodedRequestToken ?? data.nextPageToken,
    };
  }

  /**
   * Verify the cookie is still valid by hitting a lightweight endpoint.
   */
  async validateCookie(): Promise<boolean> {
    if (!this.credentials?.cookie) return false;

    try {
      // Try bootstrap first, fall back to devices endpoint
      const response = await this.request('GET', '/api/bootstrap');
      if (response.statusCode >= 200 && response.statusCode < 300) return true;

      // Bootstrap can redirect or 4xx even with valid cookies;
      // try the devices endpoint as a secondary check.
      const fallback = await this.request('GET', '/api/devices/device');
      return fallback.statusCode >= 200 && fallback.statusCode < 300;
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

    // The `type` field is a sibling of `operationPayload` on the node object,
    // NOT inside operationPayload. This matches the format used by Apollon77/
    // alexa-remote, thorsten-gehrig/alexa-remote-control, and aioamazondevices.
    const baseNode: Record<string, unknown> = {
      '@type': 'com.amazon.alexa.behaviors.model.OpaquePayloadOperationNode',
      type: '',
      operationPayload: {} as Record<string, unknown>,
    };

    const deviceTarget = {
      customerId: ownerCustomerId ?? '',
      deviceSerialNumber: deviceId,
      deviceType,
    };

    switch (command.action) {
      case 'turn_on':
        baseNode.type = 'Alexa.DeviceControls.Power';
        baseNode.operationPayload = {
          deviceType,
          deviceSerialNumber: deviceId,
          customerId: ownerCustomerId ?? '',
          action: 'turnOn',
        };
        break;

      case 'turn_off':
        baseNode.type = 'Alexa.DeviceControls.Power';
        baseNode.operationPayload = {
          deviceType,
          deviceSerialNumber: deviceId,
          customerId: ownerCustomerId ?? '',
          action: 'turnOff',
        };
        break;

      case 'set_brightness':
        baseNode.type = 'Alexa.DeviceControls.Brightness';
        baseNode.operationPayload = {
          deviceType,
          deviceSerialNumber: deviceId,
          customerId: ownerCustomerId ?? '',
          brightness: command.brightness,
        };
        break;

      case 'set_color':
        baseNode.type = 'Alexa.DeviceControls.Color';
        baseNode.operationPayload = {
          deviceType,
          deviceSerialNumber: deviceId,
          customerId: ownerCustomerId ?? '',
          colorName: undefined,
          hue: command.color.hue,
          saturation: command.color.saturation,
          brightness: command.color.brightness,
        };
        break;

      case 'set_color_temperature':
        baseNode.type = 'Alexa.DeviceControls.ColorTemperature';
        baseNode.operationPayload = {
          deviceType,
          deviceSerialNumber: deviceId,
          customerId: ownerCustomerId ?? '',
          colorTemperatureInKelvin: command.colorTemperatureInKelvin,
        };
        break;

      case 'set_volume':
        baseNode.type = 'Alexa.DeviceControls.Volume';
        baseNode.operationPayload = {
          deviceType,
          deviceSerialNumber: deviceId,
          customerId: ownerCustomerId ?? '',
          locale: 'en-US',
          value: command.volume,
        };
        break;

      case 'set_thermostat':
        baseNode.type = 'Alexa.DeviceControls.ThermostatTemperature';
        baseNode.operationPayload = {
          deviceType,
          deviceSerialNumber: deviceId,
          customerId: ownerCustomerId ?? '',
          targetTemperature: {
            value: command.targetSetpoint.value,
            scale: command.targetSetpoint.scale,
          },
          ...(command.mode ? { thermostatMode: command.mode.value } : {}),
        };
        break;

      case 'speak':
        baseNode.type = 'Alexa.Speak';
        baseNode.operationPayload = {
          deviceType,
          deviceSerialNumber: deviceId,
          customerId: ownerCustomerId ?? '',
          locale: 'en-US',
          textToSpeak: command.text,
        };
        break;

      case 'play':
        baseNode.type = 'Alexa.Media.Play';
        baseNode.operationPayload = {
          deviceType,
          deviceSerialNumber: deviceId,
          customerId: ownerCustomerId ?? '',
        };
        break;

      case 'pause':
        baseNode.type = 'Alexa.Media.Pause';
        baseNode.operationPayload = {
          deviceType,
          deviceSerialNumber: deviceId,
          customerId: ownerCustomerId ?? '',
        };
        break;

      case 'next':
        baseNode.type = 'Alexa.Media.Next';
        baseNode.operationPayload = {
          deviceType,
          deviceSerialNumber: deviceId,
          customerId: ownerCustomerId ?? '',
        };
        break;

      case 'previous':
        baseNode.type = 'Alexa.Media.Previous';
        baseNode.operationPayload = {
          deviceType,
          deviceSerialNumber: deviceId,
          customerId: ownerCustomerId ?? '',
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
  private request(
    method: string,
    path: string,
    body?: string,
    opts?: { baseUrl?: string },
  ): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
      const url = new URL(path, opts?.baseUrl ?? this.baseUrl);

      // The /nexus/v1/graphql endpoint requires a mobile-app User-Agent
      const isGraphQL = path.startsWith('/nexus/');
      const userAgent = isGraphQL
        ? 'AmazonWebView/AmazonAlexa/2.2.663733.0/iOS/18.5/iPhone'
        : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

      // When making cross-domain requests (e.g. www.amazon.com for activity
      // history), Origin/Referer must match the target host or Amazon rejects
      // the request with a CSRF / 403 error.
      const effectiveBase = opts?.baseUrl ?? this.baseUrl;

      const headers: Record<string, string> = {
        Cookie: this.credentials!.cookie,
        'User-Agent': userAgent,
        Accept: 'application/json',
        'Accept-Language': 'en-US',
        Origin: effectiveBase,
        Referer: `${effectiveBase}/`,
      };

      // CSRF handling depends on the target domain:
      // - alexa.amazon.com uses a custom 'csrf' header
      // - www.amazon.com uses the 'anti-csrftoken-a2z' cookie value as a header
      const isCrossDomain = opts?.baseUrl && !opts.baseUrl.includes('alexa.amazon');
      if (isCrossDomain) {
        // Extract anti-csrftoken-a2z from the cookie string for www.amazon.com
        const csrfMatch = this.credentials!.cookie.match(
          /anti-csrftoken-a2z=([^;]+)/,
        );
        if (csrfMatch) {
          headers['anti-csrftoken-a2z'] = csrfMatch[1];
        }
      } else if (this.credentials!.csrf) {
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
