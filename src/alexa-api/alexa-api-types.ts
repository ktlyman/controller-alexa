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
// Normalized account device
// ---------------------------------------------------------------------------

/**
 * Unified shape for devices discovered via the unofficial API.
 * Combines smart home entities, Echo devices, and group info.
 */
export interface AccountDevice {
  /** Unique identifier (entityId for smart home, serialNumber for Echo) */
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
  /** Supported capabilities (e.g., 'Alexa.PowerController') */
  capabilities: string[];
  /** Group memberships */
  groups?: string[];
  /** Raw data from the API (for advanced use) */
  raw?: Record<string, unknown>;
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
