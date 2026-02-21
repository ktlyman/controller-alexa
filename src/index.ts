/**
 * alexa-agent-tool
 *
 * Agent tool for interacting with the Alexa ecosystem:
 * - Device discovery and control
 * - Routine management
 * - Real-time and historic event logging
 */

// Main tool interface
export { AlexaAgentTool } from './agent';

// Sub-modules
export { AuthManager, LwaOAuthClient, InMemoryTokenStore } from './auth';
export type { TokenStore, TokenPair } from './auth';

export { DeviceRegistry, DeviceController } from './devices';

export { RoutineManager, InMemoryRoutineStore } from './routines';
export type { RoutineStore, StoredRoutine } from './routines';

export { EventLogger, EventGatewayClient, InMemoryEventStore } from './events';
export type { EventStore, StoredEvent, EventQuery, EventQueryResult, EventListener } from './events';

export { createHandler } from './lambda';
export type { LambdaContext } from './lambda';

export { SqliteStorage, SqliteEventStore, SqliteRoutineStore, SqliteTokenStore, SqliteCookieStore, SqliteDeviceStateStore, SqliteActivityStore } from './storage';

// Unofficial Alexa API
export { AlexaApiClient, InMemoryCookieStore, InMemoryDeviceStateStore, InMemoryActivityStore } from './alexa-api';
export type {
  CookieStore, AlexaCookieCredentials, AccountDevice, AccountDeviceCommand, AlexaApiRegion,
  DeviceStateStore, DeviceStateQuery, DeviceStateQueryResult,
  ActivityStore, ActivityQuery, ActivityQueryResult,
  ParsedCapabilityState, DeviceStateSnapshot, ActivityRecord,
} from './alexa-api';

export { loadConfig } from './config';
export type { AlexaAgentConfig } from './config';

// Types
export type {
  AlexaMessage,
  AlexaDirective,
  AlexaEvent,
  AlexaEndpoint,
  AlexaScope,
  AlexaContext,
  AlexaPropertyState,
  AlexaRegion,
  DiscoveredDevice,
  DeviceCapability,
  DisplayCategory,
  DeviceState,
  PowerState,
  Temperature,
  Color,
  ThermostatMode,
  LockState,
  ConnectivityValue,
  ChangeCause,
  ChangeReportPayload,
  AcceptGrantPayload,
} from './types/alexa';

export type {
  AgentAction,
  AgentToolResult,
  DeviceCommand,
  RoutineDefinition,
  RoutineTrigger,
  RoutineActionStep,
  RoutineSummary,
  SetAlexaCookieAction,
  ListAllDevicesAction,
  ControlAccountDeviceAction,
  SetAlexaCookieResult,
  ListAllDevicesResult,
  ControlAccountDeviceResult,
  PollDeviceStateAction,
  PollAllStatesAction,
  GetActivityHistoryAction,
  QueryStateHistoryAction,
  PollDeviceStateResult,
  PollAllStatesResult,
  GetActivityHistoryResult,
  QueryStateHistoryResult,
} from './types/agent';
