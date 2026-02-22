/**
 * Alexa Agent Tool — the primary interface for AI agents to interact
 * with the Alexa ecosystem.
 *
 * Exposes a single `execute(action)` method that accepts a discriminated
 * union of actions and returns structured results.
 *
 * Capabilities:
 * - Device discovery and control
 * - Routine listing, creation, triggering, and deletion
 * - Real-time event streaming (subscribe/unsubscribe)
 * - Historical event querying
 */

import { v4 as uuid } from 'uuid';
import type { AlexaAgentConfig } from '../config';
import { loadConfig } from '../config';
import { AuthManager } from '../auth';
import { InMemoryTokenStore } from '../auth/token-store';
import { DeviceRegistry, DeviceController } from '../devices';
import { RoutineManager } from '../routines';
import { InMemoryRoutineStore } from '../routines/routine-store';
import { EventLogger, EventGatewayClient, InMemoryEventStore } from '../events';
import type { EventStore } from '../events';
import type { RoutineStore } from '../routines/routine-store';
import type { TokenStore } from '../auth/token-store';
import { AlexaApiClient, InMemoryCookieStore } from '../alexa-api';
import type { CookieStore } from '../alexa-api';
import type { AlexaCookieCredentials, AlexaApiRegion, AccountDeviceCommand } from '../alexa-api';
import { InMemoryDeviceStateStore } from '../alexa-api/device-state-store';
import type { DeviceStateStore } from '../alexa-api/device-state-store';
import { InMemoryActivityStore } from '../alexa-api/activity-store';
import type { ActivityStore } from '../alexa-api/activity-store';
import { InMemoryPushEventStore } from '../alexa-api/push-event-store';
import type { PushEventStore } from '../alexa-api/push-event-store';
import { AlexaPushClient } from '../alexa-api/push-client';
import type { PushEvent, StoredPushEvent } from '../alexa-api/push-event-types';
import type {
  AgentAction,
  AgentToolResult,
  DiscoverDevicesResult,
  GetDeviceStateResult,
  ControlDeviceResult,
  ListRoutinesResult,
  TriggerRoutineResult,
  CreateRoutineResult,
  DeleteRoutineResult,
  QueryEventsResult,
  GetEventStreamResult,
  SetAlexaCookieResult,
  ListAllDevicesResult,
  ControlAccountDeviceResult,
  PollDeviceStateResult,
  PollAllStatesResult,
  GetCachedStatesResult,
  GetActivityHistoryResult,
  QueryStateHistoryResult,
  StartPushListenerResult,
  StopPushListenerResult,
  QueryPushEventsResult,
} from '../types/agent';

export class AlexaAgentTool {
  private config: AlexaAgentConfig;
  private auth: AuthManager;
  private registry: DeviceRegistry;
  private controller: DeviceController;
  private routines: RoutineManager;
  private eventLogger: EventLogger;
  private eventGateway: EventGatewayClient;
  private alexaApi: AlexaApiClient;
  private cookieStore: CookieStore;
  private deviceStateStore: DeviceStateStore;
  private activityStore: ActivityStore;
  private pushEventStore: PushEventStore;
  private pushClient: AlexaPushClient | null = null;
  private cleanup?: () => void;

  /** The user ID for the current session. */
  private userId: string;

  /** Timestamp of the last poll_all_states call (rate limiting). */
  private lastPollAllTime = 0;

  constructor(opts?: {
    config?: Partial<AlexaAgentConfig>;
    userId?: string;
    /** Override stores directly (takes priority over config.storageBackend) */
    eventStore?: EventStore;
    routineStore?: RoutineStore;
    tokenStore?: TokenStore;
    cookieStore?: CookieStore;
    deviceStateStore?: DeviceStateStore;
    activityStore?: ActivityStore;
    pushEventStore?: PushEventStore;
  }) {
    this.config = loadConfig(opts?.config);
    this.userId = opts?.userId ?? 'default-user';

    let eventStore = opts?.eventStore;
    let routineStore = opts?.routineStore;
    let tokenStore = opts?.tokenStore;
    let cookieStore = opts?.cookieStore;
    let deviceStateStore = opts?.deviceStateStore;
    let activityStore = opts?.activityStore;
    let pushEventStore = opts?.pushEventStore;

    // Auto-create SQLite stores when configured and no override provided
    if (this.config.storageBackend === 'sqlite' && (!eventStore || !routineStore || !tokenStore || !cookieStore)) {
      // Lazy-require to avoid breaking environments without native module
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { SqliteStorage } = require('../storage/sqlite') as typeof import('../storage/sqlite');
      const storage = new SqliteStorage(this.config.sqlitePath);
      eventStore = eventStore ?? storage.events();
      routineStore = routineStore ?? storage.routines();
      tokenStore = tokenStore ?? storage.tokens();
      cookieStore = cookieStore ?? storage.cookies();
      deviceStateStore = deviceStateStore ?? storage.deviceStates();
      activityStore = activityStore ?? storage.activities();
      pushEventStore = pushEventStore ?? storage.pushEvents();
      this.cleanup = () => storage.close();
    }

    this.auth = new AuthManager(this.config, tokenStore ?? new InMemoryTokenStore());
    this.registry = new DeviceRegistry();
    this.controller = new DeviceController(this.registry);
    this.routines = new RoutineManager(this.config, routineStore ?? new InMemoryRoutineStore());
    this.eventLogger = new EventLogger(eventStore ?? new InMemoryEventStore(this.config.maxInMemoryEvents));
    this.eventGateway = new EventGatewayClient(this.config.region);
    this.cookieStore = cookieStore ?? new InMemoryCookieStore();
    this.deviceStateStore = deviceStateStore ?? new InMemoryDeviceStateStore();
    this.activityStore = activityStore ?? new InMemoryActivityStore();
    this.pushEventStore = pushEventStore ?? new InMemoryPushEventStore();
    this.alexaApi = new AlexaApiClient(this.config.region as AlexaApiRegion);
  }

  /**
   * Close underlying resources (SQLite database, etc.).
   * Call this when you're done using the tool.
   */
  close(): void {
    if (this.pushClient) {
      this.pushClient.disconnect();
      this.pushClient = null;
    }
    this.cleanup?.();
  }

  // -----------------------------------------------------------------------
  // Accessors for sub-modules (useful for advanced integrations)
  // -----------------------------------------------------------------------

  getAuth(): AuthManager { return this.auth; }
  getDeviceRegistry(): DeviceRegistry { return this.registry; }
  getDeviceController(): DeviceController { return this.controller; }
  getRoutineManager(): RoutineManager { return this.routines; }
  getEventLogger(): EventLogger { return this.eventLogger; }
  getEventGateway(): EventGatewayClient { return this.eventGateway; }
  getAlexaApiClient(): AlexaApiClient { return this.alexaApi; }
  getPushClient(): AlexaPushClient | null { return this.pushClient; }

  // -----------------------------------------------------------------------
  // Main dispatch
  // -----------------------------------------------------------------------

  /**
   * Execute an agent action and return a structured result.
   *
   * This is the primary entry point for AI agents.
   */
  async execute(action: AgentAction): Promise<AgentToolResult> {
    const requestId = uuid();
    const start = Date.now();

    try {
      let data: unknown;

      switch (action.type) {
        case 'discover_devices':
          data = await this.discoverDevices(action.category);
          break;
        case 'get_device_state':
          data = await this.getDeviceState(action.endpointId);
          break;
        case 'control_device':
          data = await this.controlDevice(action.endpointId, action.command);
          break;
        case 'list_routines':
          data = await this.listRoutines();
          break;
        case 'trigger_routine':
          data = await this.triggerRoutine(action.routineId);
          break;
        case 'create_routine':
          data = await this.createRoutine(action.routine);
          break;
        case 'delete_routine':
          data = await this.deleteRoutine(action.routineId);
          break;
        case 'query_events':
          data = await this.queryEvents(action.query);
          break;
        case 'get_event_stream':
          data = await this.getEventStream(action.endpointIds);
          break;
        case 'set_alexa_cookie':
          data = await this.setAlexaCookie(action.cookie, action.csrf);
          break;
        case 'list_all_devices':
          data = await this.listAllDevices(action.source, action.deviceType);
          break;
        case 'control_account_device':
          data = await this.controlAccountDevice(
            action.deviceId, action.deviceType, action.command,
            action.source, action.entityId, action.alexaDeviceType,
          );
          break;
        case 'poll_device_state':
          data = await this.pollDeviceState(
            action.applianceId ?? action.entityId,
            action.deviceName,
          );
          break;
        case 'poll_all_states':
          data = await this.pollAllStates(action.entityIds, action.batchSize);
          break;
        case 'get_cached_states':
          data = await this.getCachedStates();
          break;
        case 'get_activity_history':
          data = await this.getActivityHistory(action.startTimestamp, action.endTimestamp, action.maxRecords, action.nextToken);
          break;
        case 'query_state_history':
          data = await this.queryStateHistory(action.deviceId, action.startTime, action.endTime, action.limit, action.offset);
          break;
        case 'start_push_listener':
          data = await this.startPushListener();
          break;
        case 'stop_push_listener':
          data = await this.stopPushListener();
          break;
        case 'query_push_events':
          data = await this.queryPushEvents(action);
          break;
        default: {
          const _exhaustive: never = action;
          throw new Error(`Unknown action type: ${(_exhaustive as AgentAction).type}`);
        }
      }

      return {
        success: true,
        data,
        metadata: {
          requestId,
          timestamp: new Date().toISOString(),
          durationMs: Date.now() - start,
        },
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        metadata: {
          requestId,
          timestamp: new Date().toISOString(),
          durationMs: Date.now() - start,
        },
      };
    }
  }

  // -----------------------------------------------------------------------
  // Action implementations
  // -----------------------------------------------------------------------

  private async discoverDevices(category?: string): Promise<DiscoverDevicesResult> {
    const devices = this.registry.list(category as any);

    await this.eventLogger.logCustomEvent({
      eventType: 'AgentDiscoverDevices',
      namespace: 'AlexaAgentTool',
      userId: this.userId,
      payload: { category, deviceCount: devices.length },
      tags: ['agent_action', 'discovery'],
    });

    return { devices };
  }

  private async getDeviceState(endpointId: string): Promise<GetDeviceStateResult> {
    const device = this.registry.get(endpointId);
    if (!device) {
      throw new Error(`Device ${endpointId} not found. Run discover_devices first.`);
    }

    // Build a ReportState directive
    let accessToken: string;
    try {
      accessToken = await this.auth.getAccessToken(this.userId);
    } catch {
      // In development mode without real tokens, return a placeholder state
      accessToken = '';
    }

    const directiveMsg = this.controller.buildReportStateDirective(endpointId, accessToken);

    await this.eventLogger.logAlexaMessage(directiveMsg, this.userId);

    // In a real deployment the directive would be sent to the device backend.
    // Here we return whatever state we have cached.
    return {
      state: {
        endpointId,
        properties: [],
        retrievedAt: new Date().toISOString(),
      },
    };
  }

  private async controlDevice(
    endpointId: string,
    command: import('../types/agent').DeviceCommand,
  ): Promise<ControlDeviceResult> {
    const device = this.registry.get(endpointId);
    if (!device) {
      throw new Error(`Device ${endpointId} not found. Run discover_devices first.`);
    }

    let accessToken: string;
    try {
      accessToken = await this.auth.getAccessToken(this.userId);
    } catch {
      accessToken = '';
    }

    const directiveMsg = this.controller.buildDirective(endpointId, command, accessToken);

    await this.eventLogger.logAlexaMessage(directiveMsg, this.userId);

    await this.eventLogger.logCustomEvent({
      eventType: 'AgentControlDevice',
      namespace: 'AlexaAgentTool',
      endpointId,
      userId: this.userId,
      payload: { command },
      tags: ['agent_action', 'device_control'],
    });

    return { acknowledged: true };
  }

  private async listRoutines(): Promise<ListRoutinesResult> {
    const routines = await this.routines.listRoutines();

    await this.eventLogger.logCustomEvent({
      eventType: 'AgentListRoutines',
      namespace: 'AlexaAgentTool',
      userId: this.userId,
      payload: { count: routines.length },
      tags: ['agent_action', 'routines'],
    });

    return { routines };
  }

  private async triggerRoutine(routineId: string): Promise<TriggerRoutineResult> {
    let accessToken: string | undefined;
    try {
      accessToken = await this.auth.getAccessToken(this.userId);
    } catch {
      accessToken = undefined;
    }

    const result = await this.routines.triggerRoutine(routineId, accessToken);

    // If the routine returned device actions to execute, run them
    if (result.actionsToExecute) {
      for (const step of result.actionsToExecute) {
        if (step.delaySeconds) {
          await new Promise((resolve) => setTimeout(resolve, step.delaySeconds! * 1000));
        }
        await this.controlDevice(step.endpointId, step.command);
      }
    }

    await this.eventLogger.logCustomEvent({
      eventType: 'AgentTriggerRoutine',
      namespace: 'AlexaAgentTool',
      userId: this.userId,
      payload: { routineId, triggered: result.triggered },
      tags: ['agent_action', 'routines'],
    });

    return { triggered: result.triggered };
  }

  private async createRoutine(
    routine: import('../types/agent').RoutineDefinition,
  ): Promise<CreateRoutineResult> {
    const routineId = await this.routines.createRoutine(routine);

    await this.eventLogger.logCustomEvent({
      eventType: 'AgentCreateRoutine',
      namespace: 'AlexaAgentTool',
      userId: this.userId,
      payload: { routineId, name: routine.name },
      tags: ['agent_action', 'routines'],
    });

    return { routineId };
  }

  private async deleteRoutine(routineId: string): Promise<DeleteRoutineResult> {
    const deleted = await this.routines.deleteRoutine(routineId);

    await this.eventLogger.logCustomEvent({
      eventType: 'AgentDeleteRoutine',
      namespace: 'AlexaAgentTool',
      userId: this.userId,
      payload: { routineId, deleted },
      tags: ['agent_action', 'routines'],
    });

    return { deleted };
  }

  private async queryEvents(
    query: import('../events/event-store').EventQuery,
  ): Promise<QueryEventsResult> {
    const store = this.eventLogger.getStore();
    const result = await store.query(query);

    return {
      events: result.events,
      totalCount: result.totalCount,
      cursor: result.cursor,
    };
  }

  private async getEventStream(endpointIds?: string[]): Promise<GetEventStreamResult> {
    const streamId = this.eventLogger.subscribe((_event) => {
      // In a real implementation this would push events to the agent
      // via WebSocket, SSE, or a callback URL.
    }, endpointIds);

    return { streamId, status: 'subscribed' };
  }

  // -----------------------------------------------------------------------
  // Unofficial API actions (cookie-based, all-account)
  // -----------------------------------------------------------------------

  private async setAlexaCookie(
    cookie: string,
    csrf?: string,
  ): Promise<SetAlexaCookieResult> {
    const credentials: AlexaCookieCredentials = {
      cookie,
      csrf,
      storedAt: new Date().toISOString(),
    };

    // Set on the API client
    this.alexaApi.setCredentials(credentials);

    // Validate the cookie (best-effort; the bootstrap endpoint can be flaky)
    const valid = await this.alexaApi.validateCookie();

    // Always persist — the cookie may still work for device APIs even if
    // the bootstrap endpoint returns a non-2xx status.
    await this.cookieStore.set(this.userId, this.alexaApi.getCredentials()!);

    await this.eventLogger.logCustomEvent({
      eventType: 'AgentSetAlexaCookie',
      namespace: 'AlexaAgentTool',
      userId: this.userId,
      payload: { valid, hasCSRF: !!csrf },
      tags: ['agent_action', 'auth'],
    });

    return { stored: true, valid };
  }

  private async listAllDevices(
    source?: 'smart_home' | 'echo' | 'all',
    deviceType?: string,
  ): Promise<ListAllDevicesResult> {
    await this.ensureCookieLoaded();

    let devices = await this.alexaApi.getAllDevices();

    // Apply source filter
    if (source && source !== 'all') {
      devices = devices.filter((d) => d.source === source);
    }

    // Apply device type filter
    if (deviceType) {
      devices = devices.filter(
        (d) => d.deviceType.toUpperCase() === deviceType.toUpperCase(),
      );
    }

    await this.eventLogger.logCustomEvent({
      eventType: 'AgentListAllDevices',
      namespace: 'AlexaAgentTool',
      userId: this.userId,
      payload: { source, deviceType, deviceCount: devices.length },
      tags: ['agent_action', 'discovery', 'account_api'],
    });

    return { devices, deviceCount: devices.length };
  }

  private async controlAccountDevice(
    deviceId: string,
    deviceType: string,
    command: AccountDeviceCommand,
    source?: 'smart_home' | 'echo',
    entityId?: string,
    alexaDeviceType?: string,
  ): Promise<ControlAccountDeviceResult> {
    await this.ensureCookieLoaded();

    // Determine if this is a smart home device that needs the SmartHome.Batch API.
    // Smart home devices have endpoint IDs like "amzn1.alexa.endpoint.xxx" and
    // need the Alexa.SmartHome.Batch format. Echo devices use serial numbers
    // and the Alexa.DeviceControls.* format.
    const isSmartHome = source === 'smart_home'
      || deviceId.startsWith('amzn1.alexa.endpoint.');

    if (isSmartHome) {
      // For smart home devices, use the entity ID if available, otherwise
      // try to look it up from the device list, or fall back to the device ID itself.
      let targetEntityId = entityId;
      if (!targetEntityId) {
        // Try to find the entity ID by querying devices
        try {
          const endpoints = await this.alexaApi.getSmartHomeEndpoints();
          const ep = endpoints.find(
            (e) => (e.id ?? e.endpointId) === deviceId,
          );
          targetEntityId = ep?.legacyAppliance?.entityId;
        } catch {
          // Ignore lookup failures — fall back to deviceId
        }
      }

      if (!targetEntityId) {
        // Last resort: use the deviceId directly (may work for some devices)
        targetEntityId = deviceId;
      }

      await this.alexaApi.sendSmartHomeCommand({
        entityId: targetEntityId,
        command,
      });
    } else {
      // For Echo devices, the behaviors API needs the Alexa product type code
      // (e.g. 'A3S5BH2HU6VAYF'), NOT the device family ('ECHO', 'KNIGHT').
      // alexaDeviceType carries the product code; deviceType is the display category.
      const apiDeviceType = alexaDeviceType || deviceType;
      await this.alexaApi.sendCommand({ deviceId, deviceType: apiDeviceType, command });
    }

    await this.eventLogger.logCustomEvent({
      eventType: 'AgentControlAccountDevice',
      namespace: 'AlexaAgentTool',
      endpointId: deviceId,
      userId: this.userId,
      payload: { command, source: isSmartHome ? 'smart_home' : 'echo' },
      tags: ['agent_action', 'device_control', 'account_api'],
    });

    return { acknowledged: true };
  }

  // -----------------------------------------------------------------------
  // State polling & activity history actions
  // -----------------------------------------------------------------------

  private async pollDeviceState(
    entityId: string,
    deviceName?: string,
  ): Promise<PollDeviceStateResult> {
    await this.ensureCookieLoaded();

    const nameMap = deviceName ? new Map([[entityId, deviceName]]) : undefined;
    const snapshots = await this.alexaApi.getDeviceStates([entityId], nameMap);
    const state = snapshots[0] ?? {
      deviceId: entityId,
      deviceName,
      capabilities: [],
      polledAt: new Date().toISOString(),
      error: 'No state returned from API',
    };

    await this.deviceStateStore.insert(state);

    await this.eventLogger.logCustomEvent({
      eventType: 'AgentPollDeviceState',
      namespace: 'AlexaAgentTool',
      endpointId: entityId,
      userId: this.userId,
      payload: { capabilityCount: state.capabilities.length, hasError: !!state.error },
      tags: ['agent_action', 'state_polling', 'account_api'],
    });

    return { state };
  }

  private async pollAllStates(
    entityIds?: string[],
    batchSize = 50,
  ): Promise<PollAllStatesResult> {
    await this.ensureCookieLoaded();

    // Rate limiting: minimum 5 minutes between full polls
    const RATE_LIMIT_MS = 5 * 60 * 1000;
    const elapsed = Date.now() - this.lastPollAllTime;
    if (elapsed < RATE_LIMIT_MS) {
      const waitSec = Math.ceil((RATE_LIMIT_MS - elapsed) / 1000);
      throw new Error(
        `Rate limited: poll_all_states can only run every 5 minutes. ` +
        `Please wait ${waitSec} more seconds.`,
      );
    }

    // Auto-discover applianceIds from the normalized device list.
    // The phoenix/state API requires legacyAppliance.applianceId — NOT the
    // entityId (UUID) or endpointId (amzn1.alexa.endpoint...).
    //
    // Only poll smart_home devices — Echo-source devices don't support
    // phoenix/state queries and would all return ENDPOINT_UNREACHABLE.
    const nameMap = new Map<string, string>();
    // Echo devices: dsn → { name, applianceId? } so we can store volume snapshots
    // under the same key the frontend uses for state lookup (applianceId || id)
    const echoDeviceInfo = new Map<string, { name: string; stateKey: string }>();
    let ids = entityIds;
    if (!ids || ids.length === 0) {
      const devices = await this.alexaApi.getAllDevices();
      ids = [];
      for (const d of devices) {
        if (d.source === 'echo') {
          echoDeviceInfo.set(d.id, {
            name: d.name,
            stateKey: d.applianceId || d.id,
          });
        }
        const aid = d.applianceId;
        if (aid && d.source === 'smart_home') {
          ids.push(aid);
          nameMap.set(aid, d.name);
        }
      }
    }

    if (ids.length === 0 && echoDeviceInfo.size === 0) {
      return { states: [], polledCount: 0, errorCount: 0 };
    }

    const allSnapshots: import('../alexa-api/alexa-api-types').DeviceStateSnapshot[] = [];
    let errorCount = 0;

    // Process smart home devices in batches via phoenix/state API
    for (let i = 0; i < ids.length; i += batchSize) {
      if (i > 0) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      const batch = ids.slice(i, i + batchSize);
      try {
        const snapshots = await this.alexaApi.getDeviceStates(batch, nameMap);
        allSnapshots.push(...snapshots);
        errorCount += snapshots.filter((s) => s.error).length;
      } catch {
        // Mark all in batch as errors
        for (const aid of batch) {
          allSnapshots.push({
            deviceId: aid,
            deviceName: nameMap.get(aid),
            capabilities: [],
            polledAt: new Date().toISOString(),
            error: 'Batch request failed',
          });
          errorCount++;
        }
      }
    }

    // Fetch Echo device volumes via the dedicated volume API.
    // The phoenix/state API doesn't return Alexa.Speaker for Echo devices,
    // so this is the only way to get real volume levels.
    if (echoDeviceInfo.size > 0) {
      try {
        const volumes = await this.alexaApi.getAllDeviceVolumes();
        const polledAt = new Date().toISOString();
        for (const vol of volumes) {
          // Only create snapshots for Echo devices we know about
          const info = echoDeviceInfo.get(vol.dsn);
          if (!info) continue;
          allSnapshots.push({
            // Use the same key the frontend uses for state lookup (applianceId || id)
            deviceId: info.stateKey,
            deviceName: info.name,
            capabilities: [
              {
                namespace: 'Alexa.Speaker',
                name: 'volume',
                value: vol.speakerVolume,
                timeOfSample: polledAt,
              },
              {
                namespace: 'Alexa.Speaker',
                name: 'muted',
                value: vol.speakerMuted,
                timeOfSample: polledAt,
              },
            ],
            polledAt,
          });
        }
      } catch {
        // Volume fetch is best-effort — don't fail the whole poll
      }
    }

    // Persist all snapshots
    if (allSnapshots.length > 0) {
      await this.deviceStateStore.insertBatch(allSnapshots);
    }

    this.lastPollAllTime = Date.now();

    await this.eventLogger.logCustomEvent({
      eventType: 'AgentPollAllStates',
      namespace: 'AlexaAgentTool',
      userId: this.userId,
      payload: { polledCount: allSnapshots.length, errorCount },
      tags: ['agent_action', 'state_polling', 'account_api'],
    });

    return { states: allSnapshots, polledCount: allSnapshots.length, errorCount };
  }

  private async getCachedStates(): Promise<GetCachedStatesResult> {
    const states = await this.deviceStateStore.getAllLatest();
    // Find the most recent polledAt across all snapshots
    let cachedAt: string | undefined;
    for (const s of states) {
      if (!cachedAt || s.polledAt > cachedAt) {
        cachedAt = s.polledAt;
      }
    }
    return { states, stateCount: states.length, cachedAt };
  }

  private async getActivityHistory(
    startTimestamp?: number,
    endTimestamp?: number,
    maxRecords?: number,
    nextToken?: string,
  ): Promise<GetActivityHistoryResult> {
    await this.ensureCookieLoaded();

    const result = await this.alexaApi.getActivityHistory({
      startTimestamp,
      endTimestamp,
      maxRecordSize: maxRecords,
      nextToken,
    });

    // Persist records
    if (result.records.length > 0) {
      await this.activityStore.insertBatch(result.records);
    }

    await this.eventLogger.logCustomEvent({
      eventType: 'AgentGetActivityHistory',
      namespace: 'AlexaAgentTool',
      userId: this.userId,
      payload: { recordCount: result.records.length, hasNextToken: !!result.nextToken },
      tags: ['agent_action', 'activity_history', 'account_api'],
    });

    return {
      records: result.records,
      recordCount: result.records.length,
      nextToken: result.nextToken,
    };
  }

  private async queryStateHistory(
    deviceId?: string,
    startTime?: string,
    endTime?: string,
    limit?: number,
    offset?: number,
  ): Promise<QueryStateHistoryResult> {
    const result = await this.deviceStateStore.query({
      deviceId,
      startTime,
      endTime,
      limit,
      offset,
    });

    return { snapshots: result.snapshots, totalCount: result.totalCount };
  }

  // -----------------------------------------------------------------------
  // Push listener actions
  // -----------------------------------------------------------------------

  private async startPushListener(): Promise<StartPushListenerResult> {
    if (this.pushClient?.isConnected()) {
      return {
        status: 'already_connected',
        connectionId: this.pushClient.getConnectionId() ?? 'unknown',
      };
    }

    await this.ensureCookieLoaded();
    const creds = this.alexaApi.getCredentials();
    if (!creds) {
      throw new Error(
        'No Alexa cookie configured. Use the set_alexa_cookie action first.',
      );
    }

    // Disconnect any existing client before creating new one
    if (this.pushClient) {
      this.pushClient.disconnect();
    }

    const region = (this.config.region as import('../alexa-api/alexa-api-types').AlexaApiRegion) ?? 'NA';

    this.pushClient = new AlexaPushClient({
      cookie: creds.cookie,
      region,
      onEvent: (event) => this.handlePushEvent(event),
      onStateChange: (state) => {
        this.eventLogger.logCustomEvent({
          eventType: 'PushListenerStateChange',
          namespace: 'AlexaPushClient',
          userId: this.userId,
          payload: { state },
          tags: ['push_listener', 'connection'],
        }).catch(() => {});
      },
      onError: (error) => {
        this.eventLogger.logCustomEvent({
          eventType: 'PushListenerError',
          namespace: 'AlexaPushClient',
          userId: this.userId,
          payload: { error: error.message },
          tags: ['push_listener', 'error'],
        }).catch(() => {});
      },
    });

    await this.pushClient.connect();

    const connectionId = this.pushClient.getConnectionId() ?? 'unknown';

    await this.eventLogger.logCustomEvent({
      eventType: 'AgentStartPushListener',
      namespace: 'AlexaAgentTool',
      userId: this.userId,
      payload: { connectionId },
      tags: ['agent_action', 'push_listener'],
    });

    return { status: 'connected', connectionId };
  }

  private async stopPushListener(): Promise<StopPushListenerResult> {
    if (!this.pushClient || !this.pushClient.isConnected()) {
      return { status: 'already_disconnected' };
    }

    this.pushClient.disconnect();
    this.pushClient = null;

    await this.eventLogger.logCustomEvent({
      eventType: 'AgentStopPushListener',
      namespace: 'AlexaAgentTool',
      userId: this.userId,
      payload: {},
      tags: ['agent_action', 'push_listener'],
    });

    return { status: 'disconnected' };
  }

  private async queryPushEvents(
    action: import('../types/agent').QueryPushEventsAction,
  ): Promise<QueryPushEventsResult> {
    const result = await this.pushEventStore.query({
      command: action.command,
      deviceSerial: action.deviceSerial,
      startTime: action.startTime,
      endTime: action.endTime,
      processed: action.processed,
      limit: action.limit,
      offset: action.offset,
    });

    return { events: result.events, totalCount: result.totalCount };
  }

  /**
   * Handle an incoming push event from the WebSocket client.
   * Normalizes and stores the event, logs it, and (for PUSH_ACTIVITY)
   * triggers an activity history fetch.
   */
  private async handlePushEvent(event: PushEvent): Promise<void> {
    const id = `pe-${event.command}-${event.timestamp}-${event.deviceSerial ?? 'unknown'}`;

    const stored: StoredPushEvent = {
      id,
      timestamp: new Date(event.timestamp).toISOString(),
      command: event.command,
      deviceSerial: event.deviceSerial,
      deviceType: event.deviceType,
      payload: event.payload,
      processed: false,
    };

    try {
      await this.pushEventStore.insert(stored);
    } catch {}

    try {
      await this.eventLogger.logCustomEvent({
        eventType: 'PushEventReceived',
        namespace: 'AlexaPushClient',
        endpointId: event.deviceSerial,
        userId: this.userId,
        payload: { command: event.command, deviceType: event.deviceType },
        tags: ['push_event', event.command],
      });
    } catch {}
  }

  /**
   * Ensure the AlexaApiClient has credentials loaded.
   * If not already set on the client, try loading from the cookie store.
   */
  private async ensureCookieLoaded(): Promise<void> {
    if (this.alexaApi.hasValidCredentials()) return;

    const stored = await this.cookieStore.get(this.userId);
    if (!stored) {
      throw new Error(
        'No Alexa cookie configured. Use the set_alexa_cookie action first. ' +
        'Extract your cookie from browser dev tools at alexa.amazon.com.',
      );
    }

    this.alexaApi.setCredentials(stored);
  }
}
