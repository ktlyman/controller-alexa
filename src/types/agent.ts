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
import type { StoredEvent, EventQuery } from '../events/event-store';

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
  | GetEventStreamAction;

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

export interface RoutineSummary {
  id: string;
  name: string;
  trigger: RoutineTrigger;
  actionCount: number;
  enabled: boolean;
  lastTriggered?: string; // ISO-8601
  createdAt: string;
}
