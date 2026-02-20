/**
 * Cookie storage abstraction for unofficial Alexa API credentials.
 *
 * Mirrors the TokenStore pattern but stores cookie-based credentials
 * instead of OAuth tokens.
 */

import type { AlexaCookieCredentials } from './alexa-api-types';

export interface CookieStore {
  get(userId: string): Promise<AlexaCookieCredentials | null>;
  set(userId: string, credentials: AlexaCookieCredentials): Promise<void>;
  delete(userId: string): Promise<void>;
}

/**
 * In-memory cookie store for development and testing.
 */
export class InMemoryCookieStore implements CookieStore {
  private store = new Map<string, AlexaCookieCredentials>();

  async get(userId: string): Promise<AlexaCookieCredentials | null> {
    return this.store.get(userId) ?? null;
  }

  async set(userId: string, credentials: AlexaCookieCredentials): Promise<void> {
    this.store.set(userId, credentials);
  }

  async delete(userId: string): Promise<void> {
    this.store.delete(userId);
  }
}
