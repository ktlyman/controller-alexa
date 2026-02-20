/**
 * Authentication module.
 *
 * Manages per-user LWA tokens:
 * - Exchanges authorization codes during AcceptGrant
 * - Automatically refreshes expired access tokens
 * - Provides valid bearer tokens for Event Gateway calls
 */

import { LwaOAuthClient } from './oauth-client';
import type { TokenStore, TokenPair } from './token-store';
import { InMemoryTokenStore } from './token-store';
import type { AlexaAgentConfig } from '../config';

/** Buffer before expiry to trigger a refresh (5 minutes). */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

export class AuthManager {
  private oauth: LwaOAuthClient;
  private tokens: TokenStore;

  constructor(config: AlexaAgentConfig, tokenStore?: TokenStore) {
    this.oauth = new LwaOAuthClient({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      region: config.region,
    });
    this.tokens = tokenStore ?? new InMemoryTokenStore();
  }

  /**
   * Handle the AcceptGrant directive: exchange the authorization code
   * and persist the resulting tokens.
   */
  async handleAcceptGrant(userId: string, authorizationCode: string): Promise<void> {
    const tokens = await this.oauth.exchangeAuthorizationCode(authorizationCode);
    await this.tokens.set(userId, tokens);
  }

  /**
   * Get a valid access token for the given user, refreshing if needed.
   * Throws if no tokens exist for this user.
   */
  async getAccessToken(userId: string): Promise<string> {
    const stored = await this.tokens.get(userId);
    if (!stored) {
      throw new Error(`No tokens stored for user ${userId}. Has AcceptGrant been processed?`);
    }

    if (Date.now() + REFRESH_BUFFER_MS < stored.expiresAt) {
      return stored.accessToken;
    }

    // Token expired or about to expire — refresh
    const refreshed = await this.oauth.refreshAccessToken(stored.refreshToken);
    // Keep the original refresh token if the response didn't include a new one
    const merged: TokenPair = {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken || stored.refreshToken,
      expiresAt: refreshed.expiresAt,
    };
    await this.tokens.set(userId, merged);
    return merged.accessToken;
  }

  /**
   * Obtain a client-credentials token (no user context).
   */
  async getClientToken(scope: string): Promise<string> {
    const tokens = await this.oauth.clientCredentials(scope);
    return tokens.accessToken;
  }

  /**
   * Remove stored tokens for a user (e.g., on skill disable).
   */
  async revokeUser(userId: string): Promise<void> {
    await this.tokens.delete(userId);
  }
}

export { LwaOAuthClient } from './oauth-client';
export { InMemoryTokenStore } from './token-store';
export type { TokenStore, TokenPair } from './token-store';
