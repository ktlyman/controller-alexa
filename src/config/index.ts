/**
 * Configuration for the Alexa Agent Tool.
 *
 * Values are loaded from environment variables with sensible defaults
 * for local development.
 */

import type { AlexaRegion } from '../types/alexa';

export interface AlexaAgentConfig {
  /** LWA OAuth client ID (from Alexa developer console) */
  clientId: string;
  /** LWA OAuth client secret */
  clientSecret: string;
  /** Alexa region for API endpoints */
  region: AlexaRegion;
  /** Alexa Skill ID */
  skillId: string;
  /** Storage backend */
  storageBackend: 'memory' | 'sqlite';
  /** Path to SQLite database file (when storageBackend = 'sqlite') */
  sqlitePath: string;
  /** Maximum events to retain in-memory (when storageBackend = 'memory') */
  maxInMemoryEvents: number;
  /** Port for the local webhook server that Lambda forwards to */
  localServerPort: number;
  /** Log level */
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export function loadConfig(overrides: Partial<AlexaAgentConfig> = {}): AlexaAgentConfig {
  return {
    clientId: process.env.ALEXA_CLIENT_ID ?? '',
    clientSecret: process.env.ALEXA_CLIENT_SECRET ?? '',
    region: (process.env.ALEXA_REGION as AlexaRegion) ?? 'NA',
    skillId: process.env.ALEXA_SKILL_ID ?? '',
    storageBackend: (process.env.STORAGE_BACKEND as 'memory' | 'sqlite') ?? 'sqlite',
    sqlitePath: process.env.SQLITE_PATH ?? './alexa-agent.db',
    maxInMemoryEvents: parseInt(process.env.MAX_MEMORY_EVENTS ?? '10000', 10),
    localServerPort: parseInt(process.env.LOCAL_SERVER_PORT ?? '3100', 10),
    logLevel: (process.env.LOG_LEVEL as AlexaAgentConfig['logLevel']) ?? 'info',
    ...overrides,
  };
}
