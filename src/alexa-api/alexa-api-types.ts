/**
 * Types for the unofficial Alexa Web API.
 *
 * These model the JSON returned by alexa.amazon.com endpoints
 * that the Alexa app uses internally.
 */

import type { Color, Temperature, ThermostatMode } from '../types/alexa';

// ---------------------------------------------------------------------------
// Regional base URLs
// ---------------------------------------------------------------------------

export type AlexaApiRegion = 'NA' | 'EU' | 'FE';

export const ALEXA_API_BASE_URLS: Record<AlexaApiRegion, string> = {
  NA: 'https://alexa.amazon.com',
  EU: 'https://alexa.amazon.co.uk',
  FE: 'https://alexa.amazon.co.jp',
};

// ---------------------------------------------------------------------------
// Cookie-based auth credentials
// ---------------------------------------------------------------------------

export interface AlexaCookieCredentials {
  /** The full cookie string from a logged-in browser session */
  cookie: string;
  /** CSRF token extracted from the cookie or page */
  csrf?: string;
  /** When this cookie was stored (ISO-8601) */
  storedAt: string;
  /** Optional: when the cookie is expected to expire */
  expiresAt?: string;
}

// ---------------------------------------------------------------------------
// Raw API response shapes
// ---------------------------------------------------------------------------

/** Raw smart home entity from GET /api/behaviors/entities */
export interface RawSmartHomeEntity {
  entityId: string;
  entityType: string;
  friendlyName?: string;
  providerData?: {
    categoryType?: string;
    skillId?: string;
    modelName?: string;
    manufacturerName?: string;
    deviceType?: string;
    [key: string]: unknown;
  };
  capabilities?: Array<{
    capabilityType: string;
    interfaceName: string;
    properties?: Record<string, unknown>;
    [key: string]: unknown;
  }>;
  connectedVia?: string;
  reachable?: boolean;
  [key: string]: unknown;
}

/** Raw Echo/media device from GET /api/devices/device */
export interface RawEchoDevice {
  accountName: string;
  serialNumber: string;
  deviceType: string;
  deviceOwnerCustomerId: string;
  softwareVersion: string;
  online: boolean;
  capabilities: string[];
  deviceFamily: string;
  deviceTypeFriendlyName?: string;
  registrationId?: string;
  parentClusters?: string[];
  essid?: string;
  [key: string]: unknown;
}

/** Raw device group from GET /api/phoenix/group */
export interface RawDeviceGroup {
  groupId: string;
  groupName: string;
  groupType: string;
  members: Array<{
    id: string;
    type: string;
    friendlyName?: string;
  }>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// GraphQL endpoint response (POST /nexus/v1/graphql)
// ---------------------------------------------------------------------------

/** A single endpoint item from the GraphQL `endpoints` query. */
export interface GraphQLEndpointItem {
  endpointId: string;
  id: string;
  friendlyName: string;
  displayCategories?: {
    primary?: { value: string };
  };
  legacyAppliance?: {
    applianceId: string;
    applianceTypes?: string[];
    friendlyName?: string;
    friendlyDescription?: string;
    manufacturerName?: string;
    modelName?: string;
    entityId?: string;
    actions?: string[];
    capabilities?: unknown[];
    isEnabled?: boolean;
    connectedVia?: string;
    applianceNetworkState?: {
      reachability?: string;
      [key: string]: unknown;
    };
    driverIdentity?: {
      namespace?: string;
      identifier?: string;
    };
    additionalApplianceDetails?: Record<string, unknown>;
    [key: string]: unknown;
  };
  serialNumber?: { value?: { text?: string } };
  enablement?: string;
  manufacturer?: { value?: { text?: string } };
  model?: { value?: { text?: string } };
  features?: Array<{
    name: string;
    operations?: Array<{ name: string }>;
    properties?: unknown[];
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Normalized account device
// ---------------------------------------------------------------------------

/**
 * Unified shape for devices discovered via the unofficial API.
 * Combines smart home entities, Echo devices, and group info.
 */
export interface AccountDevice {
  /** Unique identifier (endpointId for smart home, serialNumber for Echo) */
  id: string;
  /** Human-readable name */
  name: string;
  /** Where this device came from */
  source: 'smart_home' | 'echo' | 'group';
  /** Device type / category (LIGHT, SMARTPLUG, ECHO, etc.) */
  deviceType: string;
  /** Whether the device is currently reachable */
  online: boolean;
  /** Manufacturer name if known */
  manufacturer?: string;
  /** Model name if known */
  model?: string;
  /** The skill that owns this device, if applicable */
  skillId?: string;
  /** Supported capabilities as operation names (e.g., 'turnOn', 'setBrightness') */
  capabilities: string[];
  /** Alexa Smart Home interface names (e.g., 'Alexa.PowerController', 'Alexa.ContactSensor') */
  interfaces: string[];
  /** Human-readable description from the skill (e.g., "Sensor by Ring", "Pan-Tilt Indoor Cam") */
  description?: string;
  /** Group memberships */
  groups?: string[];
  /** Legacy appliance entityId (UUID) — used for smart home directive routing */
  entityId?: string;
  /** Legacy applianceId — used for phoenix/state polling (the only ID format the phoenix API accepts) */
  applianceId?: string;
  /** Alexa product type code (e.g. 'A3S5BH2HU6VAYF') — needed for Echo API commands */
  alexaDeviceType?: string;
  /** Range configuration extracted from discovery (min/max/step per instance) */
  rangeCapabilities?: RangeCapabilityConfig[];
  /** Raw data from the API (for advanced use) */
  raw?: Record<string, unknown>;
}

/** Configuration for a RangeController instance, extracted from device discovery. */
export interface RangeCapabilityConfig {
  instance: string;
  minimumValue?: number;
  maximumValue?: number;
  precision?: number;
  unitOfMeasure?: string;
  /** Semantic name from resources.friendlyNames (e.g. 'Alexa.AirQuality.Humidity', 'Particulate matter PM10') */
  friendlyName?: string;
}

// ---------------------------------------------------------------------------
// Account device commands
// ---------------------------------------------------------------------------

export type AccountDeviceCommand =
  | { action: 'turn_on' }
  | { action: 'turn_off' }
  | { action: 'set_brightness'; brightness: number }
  | { action: 'set_color'; color: Color }
  | { action: 'set_color_temperature'; colorTemperatureInKelvin: number }
  | { action: 'set_volume'; volume: number }
  | { action: 'set_thermostat'; targetSetpoint: Temperature; mode?: ThermostatMode }
  | { action: 'speak'; text: string }
  | { action: 'play' }
  | { action: 'pause' }
  | { action: 'next' }
  | { action: 'previous' };

// ---------------------------------------------------------------------------
// Phoenix state polling (POST /api/phoenix/state)
// ---------------------------------------------------------------------------

/** Parsed capability state entry from a phoenix/state response. */
export interface ParsedCapabilityState {
  namespace: string;
  name: string;
  value: unknown;
  instance?: string;
  timeOfSample?: string;
}

/** A polled state snapshot for a single device. */
export interface DeviceStateSnapshot {
  deviceId: string;
  deviceName?: string;
  capabilities: ParsedCapabilityState[];
  polledAt: string; // ISO-8601
  error?: string;
}

/** Raw phoenix/state response shape. */
export interface PhoenixStateResponse {
  deviceStates: Array<{
    entity: { entityId: string; entityType: string };
    capabilityStates?: string[]; // JSON-encoded strings that need double-parsing
    error?: { code: string; message?: string };
  }>;
  /** Top-level errors for devices that couldn't be queried at all */
  errors?: Array<{
    entity?: { entityId: string; entityType: string };
    code: string;
    message?: string;
    data?: unknown;
  }>;
}

// ---------------------------------------------------------------------------
// Activity history (POST www.amazon.com/alexa-privacy/apd/rvh/customer-history-records-v2)
// ---------------------------------------------------------------------------

/** Normalized activity record for local storage. */
export interface ActivityRecord {
  id: string;
  timestamp: string; // ISO-8601
  deviceSerial?: string;
  deviceName?: string;
  deviceType?: string;
  utteranceText?: string;
  responseText?: string;
  utteranceType?: string;
  raw?: Record<string, unknown>;
}

/** Raw response from the activity history endpoint. */
export interface ActivityHistoryResponse {
  customerHistoryRecords: Array<{
    recordKey: string;
    creationTimestamp: number;
    utteranceType?: string;
    device?: {
      deviceName?: string;
      deviceType?: string;
      serialNumber?: string;
    };
    voiceHistoryRecordItems?: Array<{
      recordItemKey: string;
      recordItemType: string;
      transcriptText?: string;
      [key: string]: unknown;
    }>;
    [key: string]: unknown;
  }>;
  encodedRequestToken?: string;
  nextPageToken?: string;
}
