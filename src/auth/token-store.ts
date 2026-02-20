/**
 * Token storage abstraction for LWA OAuth tokens.
 *
 * Each Alexa user who links their account gets a pair of tokens stored
 * here.  In production this should be backed by an encrypted store
 * (AWS Secrets Manager, DynamoDB with encryption, etc.).
 */

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix epoch ms
}

export interface TokenStore {
  get(userId: string): Promise<TokenPair | null>;
  set(userId: string, tokens: TokenPair): Promise<void>;
  delete(userId: string): Promise<void>;
}

/**
 * Simple in-memory token store for development / testing.
 */
export class InMemoryTokenStore implements TokenStore {
  private store = new Map<string, TokenPair>();

  async get(userId: string): Promise<TokenPair | null> {
    return this.store.get(userId) ?? null;
  }

  async set(userId: string, tokens: TokenPair): Promise<void> {
    this.store.set(userId, tokens);
  }

  async delete(userId: string): Promise<void> {
    this.store.delete(userId);
  }
}
