# Alexa Agent Tool

## Validation Commands

- You MUST run `npm test` before committing any changes
- You MUST run `npx tsc --noEmit` to verify type correctness
- You SHOULD run `npm run build` to confirm the full compilation succeeds

## Architecture

- `src/agent/alexa-agent-tool.ts` is the main entry point agents call via `execute(action)`
- `src/auth/` handles LWA OAuth2 flows: code exchange, token refresh, and storage
- `src/devices/` contains the device registry and directive builder for Smart Home API v3
- `src/routines/` manages routine CRUD and Alexa Custom Triggers API integration
- `src/events/` provides the event logger, event store interface, and Event Gateway client
- `src/storage/sqlite.ts` implements persistent SQLite-backed stores for all three data types
- `src/lambda/handler.ts` is the Smart Home Skill Lambda that processes Alexa directives
- `src/lambda/proxy.ts` is the minimal Lambda proxy that forwards directives to your local server
- `src/server.ts` is the local HTTP server exposing `/directive` and `/action` endpoints
- `src/types/alexa.ts` defines the Alexa Smart Home API v3 message types
- `src/types/agent.ts` defines the agent action discriminated union and result types

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
