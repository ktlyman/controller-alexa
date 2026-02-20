import { InMemoryCookieStore } from '../../src/alexa-api/cookie-store';
import type { AlexaCookieCredentials } from '../../src/alexa-api/alexa-api-types';

describe('InMemoryCookieStore', () => {
  let store: InMemoryCookieStore;

  const makeCreds = (overrides?: Partial<AlexaCookieCredentials>): AlexaCookieCredentials => ({
    cookie: 'session-id=abc123; csrf=token456',
    csrf: 'token456',
    storedAt: '2026-01-15T10:00:00.000Z',
    ...overrides,
  });

  beforeEach(() => {
    store = new InMemoryCookieStore();
  });

  it('should return null for unknown user', async () => {
    const result = await store.get('unknown-user');
    expect(result).toBeNull();
  });

  it('should store and retrieve credentials', async () => {
    const creds = makeCreds();
    await store.set('user-1', creds);

    const result = await store.get('user-1');
    expect(result).toEqual(creds);
  });

  it('should overwrite existing credentials', async () => {
    await store.set('user-1', makeCreds({ cookie: 'old-cookie' }));
    const updated = makeCreds({ cookie: 'new-cookie' });
    await store.set('user-1', updated);

    const result = await store.get('user-1');
    expect(result!.cookie).toBe('new-cookie');
  });

  it('should delete credentials', async () => {
    await store.set('user-1', makeCreds());
    await store.delete('user-1');

    const result = await store.get('user-1');
    expect(result).toBeNull();
  });

  it('should not throw when deleting nonexistent user', async () => {
    await expect(store.delete('nonexistent')).resolves.toBeUndefined();
  });

  it('should isolate credentials between users', async () => {
    await store.set('user-1', makeCreds({ cookie: 'cookie-1' }));
    await store.set('user-2', makeCreds({ cookie: 'cookie-2' }));

    expect((await store.get('user-1'))!.cookie).toBe('cookie-1');
    expect((await store.get('user-2'))!.cookie).toBe('cookie-2');
  });
});
