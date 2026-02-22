# Alexa Agent Tool

## Validation Commands

- You MUST run `npm test` before committing any changes
- You MUST run `npx tsc --noEmit` to verify type correctness
- You SHOULD run `npm run build` to confirm the full compilation succeeds

## Architecture

- `src/agent/alexa-agent-tool.ts` is the main entry point agents call via `execute(action)`
- `src/alexa-api/alexa-api-client.ts` is the cookie-based HTTP client for the unofficial Alexa Web API (GraphQL discovery, Phoenix state polling, device commands, activity history)
- `src/alexa-api/alexa-api-types.ts` defines types for `AccountDevice`, `DeviceStateSnapshot`, `ParsedCapabilityState`, `RangeCapabilityConfig`, and API response shapes
- `src/alexa-api/device-state-store.ts` defines the `DeviceStateStore` interface and in-memory implementation for polled state snapshots
- `src/alexa-api/push-client.ts` implements the `AlexaPushClient` WebSocket connection for real-time push events
- `src/auth/` handles LWA OAuth2 flows: code exchange, token refresh, and storage
- `src/devices/` contains the device registry and directive builder for Smart Home API v3
- `src/routines/` manages routine CRUD and Alexa Custom Triggers API integration
- `src/events/` provides the event logger, event store interface, and Event Gateway client
- `src/storage/sqlite.ts` implements persistent SQLite-backed stores for all seven data types (events, routines, tokens, cookies, device states, activities, push events)
- `src/lambda/handler.ts` is the Smart Home Skill Lambda that processes Alexa directives
- `src/lambda/proxy.ts` is the minimal Lambda proxy that forwards directives to your local server
- `src/server.ts` is the local HTTP server exposing `/directive`, `/action`, `/events` (SSE), `/state-history`, `/auto-poll`, and static file serving for the web dashboard
- `src/config/index.ts` defines `AlexaAgentConfig` including `autoPollIntervalMinutes`
- `src/types/alexa.ts` defines the Alexa Smart Home API v3 message types
- `src/types/agent.ts` defines the agent action discriminated union and result types
- `public/` contains the web dashboard (vanilla HTML/CSS/JS): `index.html`, `app.js`, `styles.css`

## Code Standards

- You MUST write all source code in TypeScript with strict mode enabled
- You MUST NOT add external dependencies; instead rely on `uuid`, `better-sqlite3`, and Node built-ins
- You SHOULD keep modules focused: each file SHOULD export one primary class or interface
- You MUST use the `AlexaMessage` envelope type for all Alexa API interactions
- You MUST implement the `EventStore`, `RoutineStore`, and `TokenStore` interfaces for new backends
- You SHOULD prefer `async/await` over raw callbacks; instead use Promises for all I/O

## Error Handling

- You MUST return structured `AgentToolResult` objects with `success: false` on failure
- You MUST NOT throw unhandled exceptions from `AlexaAgentTool.execute()`; instead catch and wrap errors
- You SHOULD provide descriptive error messages that guide the agent toward corrective action
- You MUST handle missing OAuth tokens gracefully by falling back to empty-string tokens in dev mode

## Security

- You MUST NOT commit `.env` files, credentials, API keys, or any secret to the repository
- You MUST store OAuth tokens via the `TokenStore` interface; prefer to encrypt sensitive data in production
- You MUST NOT log access tokens or refresh tokens; instead log only event metadata and endpoint IDs
- You SHOULD validate all bearer tokens received in Alexa directive scopes before processing
- You MUST restrict the Lambda proxy `FORWARD_URL` to HTTPS endpoints only
- You MUST NOT expose the local server directly to the internet; instead use Tailscale Funnel or similar
- You MUST NOT weaken authentication checks in production; instead use test-only overrides
- You SHOULD load configuration values from `.env` files managed outside version control

## Testing

- You MUST maintain all existing tests passing before merging changes
- You MUST add tests in `tests/` that mirror the `src/` directory structure
- You SHOULD test both in-memory and SQLite store implementations for storage changes
- You MUST NOT use real Alexa API credentials in tests; instead use mock tokens and in-memory stores

## Resolving Opaque Alexa API Metadata

The Alexa API frequently uses opaque or numeric identifiers where you might expect descriptive strings. When the frontend displays raw IDs, fallback icons, or generic labels instead of meaningful data, follow this workflow:

### The Problem Pattern

Alexa API responses often contain **opaque instance IDs** (e.g., `"4"`, `"5"`) or **encoded capability names** that don't match naive substring checks. You cannot assume instance strings will be human-readable — the same capability might be `"humidity"` on one device and `"4"` on another.

### Resolution Workflow

1. **Inspect the live SQLite database** to see what the API actually returns:
   ```bash
   sqlite3 ./alexa-agent.db "SELECT capabilities FROM device_states WHERE device_name = 'DEVICE_NAME' ORDER BY polled_at DESC LIMIT 1;"
   ```
   This reveals the actual instance strings, namespaces, and value shapes.

2. **Query the device discovery data** via the running server to see the full raw capability metadata:
   ```bash
   curl -s http://localhost:3100/action -H 'Content-Type: application/json' \
     -d '{"type":"list_all_devices","source":"smart_home"}' | python3 -c "
   import json, sys
   data = json.load(sys.stdin)
   for dev in data['data']['devices']:
       if 'DEVICE_NAME' in dev.get('name', ''):
           raw = dev.get('raw', {}).get('legacyAppliance', {})
           for cap in raw.get('capabilities', []):
               print(json.dumps(cap, indent=2))
   "
   ```
   The GraphQL discovery response includes **deeply nested metadata** that the Phoenix state API does not — particularly `resources.friendlyNames`, `semantics.stateMappings`, and `configuration` blocks.

3. **Look for semantic metadata in these locations** (in priority order):
   - `resources.friendlyNames[].value.assetId` — Alexa asset IDs like `Alexa.AirQuality.Humidity`, `Alexa.AirQuality.ParticulateMatter`
   - `resources.friendlyNames[].value.text` — Plain text names like `"Particulate matter PM10"`
   - `configuration.unitOfMeasure` — Unit strings like `Alexa.Unit.Percent`, `Alexa.Unit.PartsPerMillion`
   - `semantics.stateMappings[].states` — State labels like `Alexa.States.Detection.VOC.Good`
   - The instance string itself (only reliable when it's descriptive, not numeric)

4. **Propagate the semantic name** from discovery time (GraphQL/`getAllDevices()`) through to the frontend. Store it on `RangeCapabilityConfig.friendlyName` (or equivalent) so the rendering layer can match on it instead of the opaque instance ID.

### Known Alexa Asset ID Patterns

These are the asset IDs observed from real devices. Match against the **lowercased** asset ID since casing can vary:

| Asset ID | Meaning | Icon | Unit |
|---|---|---|---|
| `alexa.airquality.humidity` | Humidity | 💧 | % |
| `alexa.airquality.particulatematter` | PM2.5 | 🌫️ | µg/m³ |
| `alexa.airquality.volatileorganiccompounds` | VOC Index | 🍃 | idx |
| `alexa.airquality.carbonmonoxide` | CO | ⚠️ | ppm |
| `alexa.airquality.indoorairquality` | IAQ Score | 🎯 | (unitless) |
| Text: `"Particulate matter PM10"` | PM10 | 🌫️ | µg/m³ |

### Key Lesson

Never assume Alexa capability instance strings are descriptive. Always extract and propagate semantic metadata from the **discovery response** (which is richer) to the **state rendering layer** (which only sees the instance ID). When adding support for a new device type or capability, start by inspecting the raw discovery data to understand the actual field naming convention before writing matching logic.
