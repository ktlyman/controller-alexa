# alexa-agent-tool

A TypeScript toolkit that enables AI agents to interact with the Alexa Smart Home ecosystem. Control devices, manage routines, and monitor sensor data in real-time — all from a single `execute(action)` interface. Includes a web-based dashboard for manual control and monitoring.

## What It Does

- **Device control**: Discover and control Alexa-connected devices (lights, thermostats, locks, speakers, scenes, and more) via both Smart Home API v3 directives and the cookie-based account API
- **Sensor monitoring**: Track air quality monitors, temperature sensors, contact sensors, and motion detectors with automatic polling, historical sparklines, and reading freshness
- **Web dashboard**: Real-time device grid with inline controls, drag-and-drop room grouping, device modals, and live event feed
- **Routine management**: Create, list, trigger, and delete routines with schedule, device-event, or custom triggers
- **Event logging**: Real-time push event streaming via WebSocket and historical event querying with filtering, pagination, and pruning
- **Auto-polling**: Configurable interval (default 10 min) automatically polls all device states to build historical data over time
- **Persistent storage**: SQLite-backed stores for device states, events, routines, push events, activity history, cookies, and OAuth tokens

## Architecture

```
Your MacBook                                          AWS
+-----------------------------------------+   +---------------------+
|  AlexaAgentTool                         |   | Lambda proxy (70 LOC)|
|  +-- AuthManager (LWA OAuth2)           |<--| Forwards JSON to    |
|  +-- AlexaApiClient (cookie-based)      |   | your Tailscale URL  |
|  +-- DeviceController                   |   +---------------------+
|  +-- RoutineManager                     |           ^
|  +-- EventLogger (real-time)            |           |
|  +-- AlexaPushClient (WebSocket)        |   Alexa sends directives
|  +-- SQLite Storage (all data)          |
|  +-- HTTP Server (:3100)                |
|       +-- POST /directive               |
|       +-- POST /action                  |
|       +-- GET  /events (SSE)            |
|       +-- GET  /state-history           |
|       +-- GET  /auto-poll               |
|       +-- GET  /* (web dashboard)       |
+-----------------------------------------+
```

## Quick Start

### Prerequisites

- Node.js >= 18
- An [Alexa Smart Home Skill](https://developer.amazon.com/alexa/console/ask) (free)
- AWS CLI configured (`aws configure`) — [free tier](https://aws.amazon.com/free/) covers Lambda
- [Tailscale](https://tailscale.com/) with Funnel enabled (free for personal use)

### Setup

```bash
# Clone and install
cd alexa-agent-tool
npm install

# Configure credentials
cp .env.example .env
# Edit .env with your Alexa Skill's Client ID, Client Secret, and Skill ID

# Build
npm run build
```

### Deploy the Lambda Proxy (one-time)

```bash
# Start your local server and tunnel
npm run dev                          # starts server on :3100
tailscale funnel 3100                # exposes it at https://YOUR-MACHINE.YOUR-TAILNET.ts.net

# Deploy the Lambda
./scripts/setup-lambda.sh https://YOUR-MACHINE.YOUR-TAILNET.ts.net/directive
# -> Prints a Lambda ARN

# Paste the ARN into the Alexa developer console:
#   Your Skill -> Endpoint -> Default endpoint -> paste ARN -> Save
```

The Tailscale Funnel URL is stable — you only run `setup-lambda.sh` once.

### Day-to-Day Usage

```bash
npm start
# Starts the local server + Tailscale Funnel together
# Open http://localhost:3100 for the web dashboard
# Ctrl+C stops both
```

## Web Dashboard

The built-in dashboard at `http://localhost:3100` provides:

- **Device grid**: All smart home devices and Echo speakers in a responsive card grid
- **Inline controls**: Power toggles, brightness/volume sliders, speak-to-echo, lock/unlock directly on cards
- **Sensor cards**: Temperature, humidity, PM2.5, VOC, CO, IAQ readings with freshness indicators
- **Room grouping**: Drag-and-drop devices into custom rooms (persisted in localStorage)
- **Device modal**: Full controls, readable state, raw capability data, and historical sparklines
- **Auto-poll**: Toggle automatic state polling (default: every 10 minutes) to build up historical data
- **Live feed**: Real-time push event stream from Alexa WebSocket
- **Event logs**: Unified timeline of state snapshots, control actions, and push events

## Agent Interface

The primary entry point is `AlexaAgentTool.execute(action)`, which accepts a typed action and returns a structured result:

```typescript
import { AlexaAgentTool } from 'alexa-agent-tool';

const tool = new AlexaAgentTool();

// Discover devices
const devices = await tool.execute({ type: 'discover_devices' });

// Turn on a light
await tool.execute({
  type: 'control_device',
  endpointId: 'light-living-room',
  command: { action: 'turn_on' },
});

// Set thermostat
await tool.execute({
  type: 'control_device',
  endpointId: 'thermostat-1',
  command: {
    action: 'set_thermostat',
    targetSetpoint: { value: 72, scale: 'FAHRENHEIT' },
    mode: { value: 'AUTO' },
  },
});

// Poll all device states (stored in SQLite for history)
await tool.execute({ type: 'poll_all_states' });

// Query historical state snapshots
const history = await tool.execute({
  type: 'query_state_history',
  deviceId: 'sensor-air-quality',
  limit: 24,
});

// Start real-time push event listener
await tool.execute({ type: 'start_push_listener' });
```

### All Actions

| Action | Description |
|---|---|
| `discover_devices` | List registered devices, optionally filtered by category |
| `get_device_state` | Query current state of a device |
| `control_device` | Send a command: power, brightness, color, thermostat, lock, volume, scene |
| `list_all_devices` | List all account devices (smart home + Echo) via cookie API |
| `control_account_device` | Control any device via the account API |
| `poll_device_state` | Poll a single device's state via the Phoenix API |
| `poll_all_states` | Poll all smart home device states (rate limited to 5 min) |
| `get_cached_states` | Retrieve the latest cached state for all devices |
| `query_state_history` | Query historical state snapshots with time range and pagination |
| `set_alexa_cookie` | Set the Alexa cookie for account API access |
| `list_routines` | List all routines |
| `create_routine` | Create a new routine with trigger and action steps |
| `trigger_routine` | Execute a routine by ID |
| `delete_routine` | Remove a routine |
| `query_events` | Search historical events with filters and pagination |
| `get_event_stream` | Subscribe to real-time event notifications |
| `get_activity_history` | Fetch Alexa activity history (voice commands, etc.) |
| `start_push_listener` | Connect WebSocket for real-time push events |
| `stop_push_listener` | Disconnect the push event WebSocket |
| `query_push_events` | Query stored push events |

### Device Commands

| Command | Parameters |
|---|---|
| `turn_on` / `turn_off` | — |
| `set_brightness` | `brightness: number` (0-100) |
| `set_color` | `color: { hue, saturation, brightness }` |
| `set_color_temperature` | `colorTemperatureInKelvin: number` |
| `set_thermostat` | `targetSetpoint: Temperature`, optional `mode` |
| `lock` / `unlock` | — |
| `set_volume` | `volume: number` (0-100) |
| `set_mute` | `mute: boolean` |
| `set_percentage` | `percentage: number` (0-100) |
| `activate_scene` / `deactivate_scene` | — |
| `speak` | `text: string` (Echo devices only) |
| `play` / `pause` / `next` / `previous` | — (Echo devices only) |

## HTTP API

When running the server, you can also interact via HTTP:

```bash
# Agent action
curl -X POST http://localhost:3100/action \
  -H 'Content-Type: application/json' \
  -d '{"type": "list_all_devices", "source": "all"}'

# State history for a device
curl 'http://localhost:3100/state-history?deviceId=APPLIANCE_ID&limit=24'

# Auto-poll status
curl http://localhost:3100/auto-poll

# Toggle auto-poll
curl -X POST http://localhost:3100/auto-poll \
  -H 'Content-Type: application/json' \
  -d '{"enabled": true, "intervalMinutes": 10}'

# Server-Sent Events (real-time)
curl http://localhost:3100/events
```

## Project Structure

```
src/
+-- agent/          AlexaAgentTool -- unified execute() interface
+-- alexa-api/      Cookie-based API client, state stores, push client
+-- auth/           LWA OAuth2 client, token storage, auto-refresh
+-- config/         Environment-driven configuration
+-- devices/        Device registry and Smart Home directive builder
+-- events/         Event store, logger (real-time + historic), Event Gateway client
+-- lambda/         Smart Home Skill handler + minimal proxy for AWS
+-- routines/       Routine CRUD and custom trigger API
+-- storage/        SQLite-backed persistent stores
+-- types/          Alexa API and agent action type definitions
+-- server.ts       Local HTTP server with auto-poll, SSE, and static serving

public/             Web dashboard (vanilla HTML/CSS/JS)
+-- index.html      Dashboard layout with tabs and modal
+-- app.js          Frontend application logic
+-- styles.css      Design system and component styles

tests/              Mirrors src/ structure -- 270 tests across 14 suites
scripts/
+-- setup-lambda.sh One-command Lambda deployment
+-- start.sh        Starts server + Tailscale Funnel together
```

## Configuration

All configuration is via environment variables (or `.env` file):

| Variable | Default | Description |
|---|---|---|
| `ALEXA_CLIENT_ID` | — | LWA OAuth client ID |
| `ALEXA_CLIENT_SECRET` | — | LWA OAuth client secret |
| `ALEXA_SKILL_ID` | — | Alexa Smart Home skill ID |
| `ALEXA_REGION` | `NA` | `NA`, `EU`, or `FE` |
| `STORAGE_BACKEND` | `sqlite` | `sqlite` or `memory` |
| `SQLITE_PATH` | `./alexa-agent.db` | Path to SQLite database file |
| `LOCAL_SERVER_PORT` | `3100` | Port for the local HTTP server |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `AUTO_POLL_INTERVAL_MINUTES` | `10` | Auto-poll interval in minutes (0 to disable) |

## Storage

By default, all data persists in a single SQLite file (`alexa-agent.db`). This stores:

- **Device states**: Polled capability snapshots with timestamps for historical tracking
- **Events**: Every Alexa directive, response, state change, and agent action
- **Routines**: Definitions, triggers, action steps, and execution history
- **Tokens**: Per-user LWA OAuth access and refresh tokens
- **Cookies**: Alexa session cookies for the account API
- **Push events**: Raw WebSocket push events from Alexa
- **Activity history**: Voice command and interaction records

For testing or ephemeral use, set `STORAGE_BACKEND=memory`.

All backends implement the same store interfaces (`EventStore`, `RoutineStore`, `TokenStore`, `DeviceStateStore`, `CookieStore`, `ActivityStore`, `PushEventStore`).

## Cost

The AWS Lambda proxy runs within the permanent free tier for personal use:

| Resource | Free Tier | Typical Usage |
|---|---|---|
| Lambda invocations | 1M/month | Hundreds/month |
| Lambda compute | 400K GB-sec/month | ~0.001 GB-sec per call |
| Tailscale Funnel | Free (personal) | Always-on tunnel |

## Development

```bash
npm test              # Run all 270 tests
npm test -- --watch   # Watch mode
npm run dev           # Start server with ts-node (no build needed)
npm run build         # Compile TypeScript
npx tsc --noEmit      # Type check without emitting
```

## License

MIT
