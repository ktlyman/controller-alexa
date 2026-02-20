/**
 * Login with Amazon (LWA) OAuth2 client.
 *
 * Handles the authorization-code exchange that happens during AcceptGrant,
 * token refresh, and client-credentials grants.
 */

import https from 'https';
import { URL } from 'url';
import type { AlexaRegion } from '../types/alexa';
import { TOKEN_ENDPOINTS } from '../types/alexa';
import type { TokenPair } from './token-store';

export interface OAuthClientOptions {
  clientId: string;
  clientSecret: string;
  region: AlexaRegion;
}

export class LwaOAuthClient {
  private clientId: string;
  private clientSecret: string;
  private tokenEndpoint: string;

  constructor(opts: OAuthClientOptions) {
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.tokenEndpoint = TOKEN_ENDPOINTS[opts.region];
  }

  /**
   * Exchange an authorization code (from AcceptGrant) for access + refresh tokens.
   */
  async exchangeAuthorizationCode(code: string): Promise<TokenPair> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });
    return this.postToken(body);
  }

  /**
   * Refresh an expired access token using a refresh token.
   */
  async refreshAccessToken(refreshToken: string): Promise<TokenPair> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });
    return this.postToken(body);
  }

  /**
   * Obtain a token using client credentials (for server-to-server APIs
   * like the Proactive Events API).
   */
  async clientCredentials(scope: string): Promise<TokenPair> {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      scope,
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });
    return this.postToken(body);
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private postToken(body: URLSearchParams): Promise<TokenPair> {
    return new Promise((resolve, reject) => {
      const url = new URL(this.tokenEndpoint);
      const payload = body.toString();

      const req = https.request(
        {
          hostname: url.hostname,
          port: 443,
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(payload),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk: string) => (data += chunk));
          res.on('end', () => {
            if (res.statusCode !== 200) {
              reject(new Error(`LWA token request failed (${res.statusCode}): ${data}`));
              return;
            }
            try {
              const json = JSON.parse(data);
              resolve({
                accessToken: json.access_token,
                refreshToken: json.refresh_token ?? '',
                expiresAt: Date.now() + json.expires_in * 1000,
              });
            } catch (e) {
              reject(new Error(`Failed to parse LWA response: ${data}`));
            }
          });
        },
      );

      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }
}
