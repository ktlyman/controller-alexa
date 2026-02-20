/**
 * Core Alexa Smart Home API type definitions.
 *
 * These types model the directive/event message format used by the
 * Smart Home Skill API v3, the Event Gateway, and the LWA OAuth flow.
 */

// ---------------------------------------------------------------------------
// Common message envelope
// ---------------------------------------------------------------------------

export interface AlexaMessageHeader {
  namespace: string;
  name: string;
  messageId: string;
  correlationToken?: string;
  payloadVersion: '3';
}

export interface AlexaEndpoint {
  endpointId: string;
  scope?: AlexaScope;
  cookie?: Record<string, string>;
}

export interface AlexaScope {
  type: 'BearerToken' | 'BearerTokenWithPartition';
  token: string;
  partition?: string;
  userId?: string;
}

export interface AlexaDirective<P = Record<string, unknown>> {
  header: AlexaMessageHeader;
  endpoint?: AlexaEndpoint;
  payload: P;
}

export interface AlexaEvent<P = Record<string, unknown>> {
  header: AlexaMessageHeader;
  endpoint?: AlexaEndpoint;
  payload: P;
}

export interface AlexaContext {
  properties: AlexaPropertyState[];
}

export interface AlexaPropertyState {
  namespace: string;
  name: string;
  value: unknown;
  timeOfSample: string; // ISO-8601
  uncertaintyInMilliseconds: number;
}

export interface AlexaMessage<P = Record<string, unknown>> {
  directive?: AlexaDirective<P>;
  event?: AlexaEvent<P>;
  context?: AlexaContext;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export type DisplayCategory =
  | 'LIGHT'
  | 'SMARTPLUG'
  | 'SWITCH'
  | 'THERMOSTAT'
  | 'TEMPERATURE_SENSOR'
  | 'LOCK'
  | 'CAMERA'
  | 'DOORBELL'
  | 'SCENE_TRIGGER'
  | 'ACTIVITY_TRIGGER'
  | 'SPEAKER'
  | 'TV'
  | 'FAN'
  | 'SECURITY_PANEL'
  | 'CONTACT_SENSOR'
  | 'MOTION_SENSOR'
  | 'OTHER';

export interface CapabilityProperty {
  supported: Array<{ name: string }>;
  proactivelyReported: boolean;
  retrievable: boolean;
}

export interface DeviceCapability {
  type: 'AlexaInterface';
  interface: string;
  version: '3';
  properties?: CapabilityProperty;
  instance?: string;
  configuration?: Record<string, unknown>;
  capabilityResources?: Record<string, unknown>;
  semantics?: Record<string, unknown>;
}

export interface DiscoveredDevice {
  endpointId: string;
  manufacturerName: string;
  description: string;
  friendlyName: string;
  displayCategories: DisplayCategory[];
  capabilities: DeviceCapability[];
  cookie?: Record<string, string>;
  connections?: Array<{
    type: string;
    macAddress?: string;
    value?: string;
  }>;
}

// ---------------------------------------------------------------------------
// Device state
// ---------------------------------------------------------------------------

export type PowerState = 'ON' | 'OFF';

export interface ThermostatMode {
  value: 'HEAT' | 'COOL' | 'AUTO' | 'ECO' | 'OFF';
  customName?: string;
}

export interface Temperature {
  value: number;
  scale: 'CELSIUS' | 'FAHRENHEIT' | 'KELVIN';
}

export interface Color {
  hue: number;       // 0-360
  saturation: number; // 0-1
  brightness: number; // 0-1
}

export type LockState = 'LOCKED' | 'UNLOCKED' | 'JAMMED';

export type ConnectivityValue = 'OK' | 'UNREACHABLE';

export interface DeviceState {
  endpointId: string;
  properties: AlexaPropertyState[];
  retrievedAt: string; // ISO-8601
}

// ---------------------------------------------------------------------------
// Change reports / events
// ---------------------------------------------------------------------------

export type ChangeCause =
  | 'VOICE_INTERACTION'
  | 'APP_INTERACTION'
  | 'PHYSICAL_INTERACTION'
  | 'RULE_TRIGGER'
  | 'PERIODIC_POLL';

export interface ChangeReportPayload {
  change: {
    cause: { type: ChangeCause };
    properties: AlexaPropertyState[];
  };
}

// ---------------------------------------------------------------------------
// Authorization (AcceptGrant)
// ---------------------------------------------------------------------------

export interface AcceptGrantPayload {
  grant: {
    type: 'OAuth2.AuthorizationCode';
    code: string;
  };
  grantee: {
    type: 'BearerToken';
    token: string;
  };
}

// ---------------------------------------------------------------------------
// Regions
// ---------------------------------------------------------------------------

export type AlexaRegion = 'NA' | 'EU' | 'FE';

export const EVENT_GATEWAY_URLS: Record<AlexaRegion, string> = {
  NA: 'https://api.amazonalexa.com/v3/events',
  EU: 'https://api.eu.amazonalexa.com/v3/events',
  FE: 'https://api.fe.amazonalexa.com/v3/events',
};

export const TOKEN_ENDPOINTS: Record<AlexaRegion, string> = {
  NA: 'https://api.amazon.com/auth/o2/token',
  EU: 'https://api.amazon.co.uk/auth/o2/token',
  FE: 'https://api.amazon.co.jp/auth/o2/token',
};
