import { AuthManager, InMemoryTokenStore, TokenPair } from '../../src/auth';
import { loadConfig } from '../../src/config';

describe('AuthManager', () => {
  let auth: AuthManager;
  let tokenStore: InMemoryTokenStore;
  const config = loadConfig({
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    region: 'NA',
  });

  beforeEach(() => {
    tokenStore = new InMemoryTokenStore();
    auth = new AuthManager(config, tokenStore);
  });

  describe('token store integration', () => {
    it('should throw when getting token for unknown user', async () => {
      await expect(auth.getAccessToken('unknown-user')).rejects.toThrow(
        'No tokens stored for user unknown-user',
      );
    });

    it('should return a valid access token when tokens are present and not expired', async () => {
      const tokens: TokenPair = {
        accessToken: 'Atza|test-access-token',
        refreshToken: 'Atzr|test-refresh-token',
        expiresAt: Date.now() + 60 * 60 * 1000, // 1 hour from now
      };
      await tokenStore.set('user-1', tokens);

      const result = await auth.getAccessToken('user-1');
      expect(result).toBe('Atza|test-access-token');
    });

    it('should revoke user tokens', async () => {
      const tokens: TokenPair = {
        accessToken: 'Atza|test',
        refreshToken: 'Atzr|test',
        expiresAt: Date.now() + 60 * 60 * 1000,
      };
      await tokenStore.set('user-1', tokens);

      await auth.revokeUser('user-1');

      await expect(auth.getAccessToken('user-1')).rejects.toThrow(
        'No tokens stored for user user-1',
      );
    });
  });
});

describe('InMemoryTokenStore', () => {
  let store: InMemoryTokenStore;

  beforeEach(() => {
    store = new InMemoryTokenStore();
  });

  it('should return null for missing user', async () => {
    expect(await store.get('nonexistent')).toBeNull();
  });

  it('should store and retrieve tokens', async () => {
    const tokens: TokenPair = {
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: 12345,
    };
    await store.set('user-1', tokens);
    expect(await store.get('user-1')).toEqual(tokens);
  });

  it('should delete tokens', async () => {
    await store.set('user-1', {
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: 0,
    });
    await store.delete('user-1');
    expect(await store.get('user-1')).toBeNull();
  });

  it('should overwrite existing tokens', async () => {
    await store.set('user-1', {
      accessToken: 'old',
      refreshToken: 'old',
      expiresAt: 0,
    });
    const updated: TokenPair = {
      accessToken: 'new',
      refreshToken: 'new',
      expiresAt: 999,
    };
    await store.set('user-1', updated);
    expect(await store.get('user-1')).toEqual(updated);
  });
});
