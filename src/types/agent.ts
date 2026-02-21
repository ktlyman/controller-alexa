/**
 * Types for the agent-facing tool interface.
 *
 * These define the actions an AI agent can take and the structured
 * results it receives back.
 */

import type {
  DeviceState,
  DiscoveredDevice,
  DisplayCategory,
  PowerState,
  Temperature,
  Color,
  ThermostatMode,
} from './alexa';
import type { AccountDevice, AccountDeviceCommand, DeviceStateSnapshot, ActivityRecord } from '../alexa-api/alexa-api-types';
import type { StoredEvent, EventQuery } from '../events/event-store';
import type { StoredPushEvent } from '../alexa-api/push-event-types';

// ---------------------------------------------------------------------------
// Tool action discriminated union
// ---------------------------------------------------------------------------

export type AgentAction =
  | DiscoverDevicesAction
  | GetDeviceStateAction
  | ControlDeviceAction
  | ListRoutinesAction
  | TriggerRoutineAction
  | CreateRoutineAction
  | DeleteRoutineAction
  | QueryEventsAction
  | GetEventStreamAction
  | SetAlexaCookieAction
  | ListAllDevicesAction
  | ControlAccountDeviceAction
  | PollDeviceStateAction
  | PollAllStatesAction
  | GetActivityHistoryAction
  | QueryStateHistoryAction
  | StartPushListenerAction
  | StopPushListenerAction
  | QueryPushEventsAction;

// -- Device actions ---------------------------------------------------------

export interface DiscoverDevicesAction {
  type: 'discover_devices';
  /** Optional filter by display category */
  category?: DisplayCategory;
}

export interface GetDeviceStateAction {
  type: 'get_device_state';
  endpointId: string;
}

export interface ControlDeviceAction {
  type: 'control_device';
  endpointId: string;
  command: DeviceCommand;
}

export type DeviceCommand =
  | { action: 'turn_on' }
  | { action: 'turn_off' }
  | { action: 'set_brightness'; brightness: number }
  | { action: 'set_color'; color: Color }
  | { action: 'set_color_temperature'; colorTemperatureInKelvin: number }
  | { action: 'set_thermostat'; targetSetpoint: Temperature; mode?: ThermostatMode }
  | { action: 'lock' }
  | { action: 'unlock' }
  | { action: 'set_volume'; volume: number }
  | { action: 'set_mute'; mute: boolean }
  | { action: 'set_percentage'; percentage: number }
  | { action: 'activate_scene' }
  | { action: 'deactivate_scene' };

// -- Routine actions --------------------------------------------------------

export interface ListRoutinesAction {
  type: 'list_routines';
}

export interface TriggerRoutineAction {
  type: 'trigger_routine';
  routineId: string;
}

export interface CreateRoutineAction {
  type: 'create_routine';
  routine: RoutineDefinition;
}

export interface DeleteRoutineAction {
  type: 'delete_routine';
  routineId: string;
}

export interface RoutineDefinition {
  name: string;
  trigger: RoutineTrigger;
  actions: RoutineActionStep[];
}

export type RoutineTrigger =
  | { type: 'schedule'; cron: string }
  | { type: 'device_event'; endpointId: string; property: string; value: unknown }
  | { type: 'custom'; triggerId: string };

export interface RoutineActionStep {
  type: 'device_command';
  endpointId: string;
  command: DeviceCommand;
  delaySeconds?: number;
}

// -- Unofficial API actions (cookie-based, all-account) --------------------

export interface SetAlexaCookieAction {
  type: 'set_alexa_cookie';
  /** Full cookie string from browser dev tools */
  cookie: string;
  /** Optional CSRF token (auto-extracted from cookie if omitted) */
  csrf?: string;
}

export interface ListAllDevicesAction {
  type: 'list_all_devices';
  /** Filter by source: 'smart_home', 'echo', or 'all' (default) */
  source?: 'smart_home' | 'echo' | 'all';
  /** Filter by device type string (e.g., 'LIGHT', 'ECHO') */
  deviceType?: string;
}

export interface ControlAccountDeviceAction {
  type: 'control_account_device';
  /** The device ID (entityId or serialNumber) */
  deviceId: string;
  /** The device type (needed for the behaviors API) */
  deviceType: string;
  /** The command to execute */
  command: AccountDeviceCommand;
}

// -- State polling & activity history actions -------------------------------

export interface PollDeviceStateAction {
  type: 'poll_device_state';
  /** The entityId (legacyAppliance.entityId from GraphQL) to poll */
  entityId: string;
  /** Optional human-readable name for the snapshot */
  deviceName?: string;
}

export interface PollAllStatesAction {
  type: 'poll_all_states';
  /** Specific entityIds to poll; if omitted, auto-discovers from GraphQL */
  entityIds?: string[];
  /** Number of devices per batch (default 10) */
  batchSize?: number;
}

export interface GetActivityHistoryAction {
  type: 'get_activity_history';
  /** Unix timestamp in ms (default: 7 days ago) */
  startTimestamp?: number;
  /** Unix timestamp in ms (default: now) */
  endTimestamp?: number;
  /** Max records per page (default: 50) */
  maxRecords?: number;
  /** Pagination token from a previous response */
  nextToken?: string;
}

export interface QueryStateHistoryAction {
  type: 'query_state_history';
  /** Filter by device ID */
  deviceId?: string;
  /** ISO-8601 start time */
  startTime?: string;
  /** ISO-8601 end time */
  endTime?: string;
  /** Max results (default 100) */
  limit?: number;
  /** Pagination offset (default 0) */
  offset?: number;
}

// -- Push listener actions ---------------------------------------------------

export interface StartPushListenerAction {
  type: 'start_push_listener';
}

export interface StopPushListenerAction {
  type: 'stop_push_listener';
}

export interface QueryPushEventsAction {
  type: 'query_push_events';
  /** Filter by push event command (e.g., 'PUSH_ACTIVITY') */
  command?: string;
  /** Filter by device serial number */
  deviceSerial?: string;
  /** ISO-8601 start time */
  startTime?: string;
  /** ISO-8601 end time */
  endTime?: string;
  /** Filter by processed flag */
  processed?: boolean;
  /** Max results (default 100) */
  limit?: number;
  /** Pagination offset (default 0) */
  offset?: number;
}

// -- Event actions ----------------------------------------------------------

export interface QueryEventsAction {
  type: 'query_events';
  query: EventQuery;
}

export interface GetEventStreamAction {
  type: 'get_event_stream';
  /** Subscribe to real-time events for these endpoint IDs (empty = all) */
  endpointIds?: string[];
}

// ---------------------------------------------------------------------------
// Tool result
// ---------------------------------------------------------------------------

export interface AgentToolResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  metadata?: {
    requestId: string;
    timestamp: string;
    durationMs: number;
  };
}

// Specific result data shapes
export type DiscoverDevicesResult = { devices: DiscoveredDevice[] };
export type GetDeviceStateResult = { state: DeviceState };
export type ControlDeviceResult = { newState?: Partial<DeviceState>; acknowledged: boolean };
export type ListRoutinesResult = { routines: RoutineSummary[] };
export type TriggerRoutineResult = { triggered: boolean };
export type CreateRoutineResult = { routineId: string };
export type DeleteRoutineResult = { deleted: boolean };
export type QueryEventsResult = { events: StoredEvent[]; totalCount: number; cursor?: string };
export type GetEventStreamResult = { streamId: string; status: 'subscribed' };
export type SetAlexaCookieResult = { stored: boolean; valid: boolean };
export type ListAllDevicesResult = { devices: AccountDevice[]; deviceCount: number };
export type ControlAccountDeviceResult = { acknowledged: boolean };
export type PollDeviceStateResult = { state: DeviceStateSnapshot };
export type PollAllStatesResult = { states: DeviceStateSnapshot[]; polledCount: number; errorCount: number };
export type GetActivityHistoryResult = { records: ActivityRecord[]; recordCount: number; nextToken?: string };
export type QueryStateHistoryResult = { snapshots: DeviceStateSnapshot[]; totalCount: number };
export type StartPushListenerResult = { status: 'connected' | 'already_connected'; connectionId: string };
export type StopPushListenerResult = { status: 'disconnected' | 'already_disconnected' };
export type QueryPushEventsResult = { events: StoredPushEvent[]; totalCount: number };

export interface RoutineSummary {
  id: string;
  name: string;
  trigger: RoutineTrigger;
  actionCount: number;
  enabled: boolean;
  lastTriggered?: string; // ISO-8601
  createdAt: string;
}
