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
  private cleanup?: () => void;

  /** The user ID for the current session. */
  private userId: string;

  constructor(opts?: {
    config?: Partial<AlexaAgentConfig>;
    userId?: string;
    /** Override stores directly (takes priority over config.storageBackend) */
    eventStore?: EventStore;
    routineStore?: RoutineStore;
    tokenStore?: TokenStore;
    cookieStore?: CookieStore;
  }) {
    this.config = loadConfig(opts?.config);
    this.userId = opts?.userId ?? 'default-user';

    let eventStore = opts?.eventStore;
    let routineStore = opts?.routineStore;
    let tokenStore = opts?.tokenStore;
    let cookieStore = opts?.cookieStore;

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
      this.cleanup = () => storage.close();
    }

    this.auth = new AuthManager(this.config, tokenStore ?? new InMemoryTokenStore());
    this.registry = new DeviceRegistry();
    this.controller = new DeviceController(this.registry);
    this.routines = new RoutineManager(this.config, routineStore ?? new InMemoryRoutineStore());
    this.eventLogger = new EventLogger(eventStore ?? new InMemoryEventStore(this.config.maxInMemoryEvents));
    this.eventGateway = new EventGatewayClient(this.config.region);
    this.cookieStore = cookieStore ?? new InMemoryCookieStore();
    this.alexaApi = new AlexaApiClient(this.config.region as AlexaApiRegion);
  }

  /**
   * Close underlying resources (SQLite database, etc.).
   * Call this when you're done using the tool.
   */
  close(): void {
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
          data = await this.controlAccountDevice(action.deviceId, action.deviceType, action.command);
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
  ): Promise<ControlAccountDeviceResult> {
    await this.ensureCookieLoaded();

    await this.alexaApi.sendCommand({ deviceId, deviceType, command });

    await this.eventLogger.logCustomEvent({
      eventType: 'AgentControlAccountDevice',
      namespace: 'AlexaAgentTool',
      endpointId: deviceId,
      userId: this.userId,
      payload: { command },
      tags: ['agent_action', 'device_control', 'account_api'],
    });

    return { acknowledged: true };
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
