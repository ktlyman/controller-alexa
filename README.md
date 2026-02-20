# alexa-agent-tool

A TypeScript toolkit that enables AI agents to interact with the Alexa Smart Home ecosystem. Control devices, manage routines, and log events in real-time — all from a single `execute(action)` interface.

## What It Does

- **Device control**: Discover and control Alexa-connected devices (lights, thermostats, locks, speakers, scenes, and more) via Smart Home API v3 directives
- **Routine management**: Create, list, trigger, and delete routines with schedule, device-event, or custom triggers
- **Event logging**: Real-time pub/sub streaming and historical event querying with filtering, pagination, and pruning
- **Persistent storage**: SQLite-backed stores for events, routines, and OAuth tokens that survive restarts
- **Local-first architecture**: Everything runs on your machine; a minimal stateless Lambda proxy satisfies Alexa's endpoint requirement

## Architecture

```
Your MacBook                                          AWS
┌──────────────────────────────────┐     ┌──────────────────────┐
│  AlexaAgentTool                  │     │  Lambda proxy (70 LOC)│
│  ├── AuthManager (LWA OAuth2)    │◄────│  Forwards JSON to    │
│  ├── DeviceController            │     │  your Tailscale URL  │
│  ├── RoutineManager              │     └──────────────────────┘
│  ├── EventLogger (real-time)     │              ▲
│  ├── EventStore (SQLite)         │              │
│  └── HTTP Server (:3100)         │     Alexa sends directives
│       ├── POST /directive        │
│       └── POST /action           │
└──────────────────────────────────┘
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
# → Prints a Lambda ARN

# Paste the ARN into the Alexa developer console:
#   Your Skill → Endpoint → Default endpoint → paste ARN → Save
```

The Tailscale Funnel URL is stable — you only run `setup-lambda.sh` once.

### Day-to-Day Usage

```bash
npm start
# Starts the local server + Tailscale Funnel together
# Ctrl+C stops both
```

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

// Create a routine
await tool.execute({
  type: 'create_routine',
  routine: {
    name: 'Bedtime',
    trigger: { type: 'schedule', cron: '0 22 * * *' },
    actions: [
      { type: 'device_command', endpointId: 'light-bedroom', command: { action: 'turn_off' } },
      { type: 'device_command', endpointId: 'thermostat-1', command: { action: 'set_thermostat', targetSetpoint: { value: 68, scale: 'FAHRENHEIT' } }, delaySeconds: 5 },
    ],
  },
});

// Query historical events
const events = await tool.execute({
  type: 'query_events',
  query: { endpointId: 'light-living-room', limit: 50 },
});

// Subscribe to real-time events
const stream = await tool.execute({
  type: 'get_event_stream',
  endpointIds: ['light-living-room', 'thermostat-1'],
});
```

### All Actions

| Action | Description |
|---|---|
| `discover_devices` | List registered devices, optionally filtered by category |
| `get_device_state` | Query current state of a device |
| `control_device` | Send a command: power, brightness, color, thermostat, lock, volume, scene |
| `list_routines` | List all routines |
| `create_routine` | Create a new routine with trigger and action steps |
| `trigger_routine` | Execute a routine by ID |
| `delete_routine` | Remove a routine |
| `query_events` | Search historical events with filters and pagination |
| `get_event_stream` | Subscribe to real-time event notifications |

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

## HTTP API

When running the server, you can also interact via HTTP:

```bash
# Agent action
curl -X POST http://localhost:3100/action \
  -H 'Content-Type: application/json' \
  -d '{"type": "discover_devices"}'

# Health check
curl http://localhost:3100/health
```

## Project Structure

```
src/
├── agent/          AlexaAgentTool — unified execute() interface
├── auth/           LWA OAuth2 client, token storage, auto-refresh
├── config/         Environment-driven configuration
├── devices/        Device registry and Smart Home directive builder
├── events/         Event store, logger (real-time + historic), Event Gateway client
├── lambda/         Smart Home Skill handler + minimal proxy for AWS
├── routines/       Routine CRUD and custom trigger API
├── storage/        SQLite-backed persistent stores
├── types/          Alexa API and agent action type definitions
└── server.ts       Local HTTP server

tests/              Mirrors src/ structure — 115 tests across 8 suites
scripts/
├── setup-lambda.sh One-command Lambda deployment
└── start.sh        Starts server + Tailscale Funnel together
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

## Storage

By default, all data persists in a single SQLite file (`alexa-agent.db`). This stores:

- **Events**: Every Alexa directive, response, state change, and agent action
- **Routines**: Definitions, triggers, action steps, and execution history
- **Tokens**: Per-user LWA OAuth access and refresh tokens

For testing or ephemeral use, set `STORAGE_BACKEND=memory`.

Both backends implement the same `EventStore`, `RoutineStore`, and `TokenStore` interfaces.

## Cost

The AWS Lambda proxy runs within the permanent free tier for personal use:

| Resource | Free Tier | Typical Usage |
|---|---|---|
| Lambda invocations | 1M/month | Hundreds/month |
| Lambda compute | 400K GB-sec/month | ~0.001 GB-sec per call |
| Tailscale Funnel | Free (personal) | Always-on tunnel |

## Development

```bash
npm test              # Run all 115 tests
npm test -- --watch   # Watch mode
npm run dev           # Start server with ts-node (no build needed)
npm run build         # Compile TypeScript
```

## License

MIT
