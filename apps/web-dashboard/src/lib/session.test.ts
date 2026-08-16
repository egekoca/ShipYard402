// @vitest-environment jsdom
import type { ShipyardApiClient } from '@shipyard402/public-api-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const signPersonalMessage = vi.fn();

vi.mock('./goat-wallet', () => ({
  signPersonalMessage: (...args: unknown[]) => signPersonalMessage(...args),
}));

import { clearStoredSession, ensureSession, getStoredSessionToken } from './session';

const STORAGE_KEY = 'shipyard402:session:goat';
const ADDRESS = '0xAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaa' as const;
const OTHER_ADDRESS = '0xBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbb' as const;

function store(session: Readonly<{ address: string; token: string; expiresAt: string }>): void {
  window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

function inOneHour(): string {
  return new Date(Date.now() + 3_600_000).toISOString();
}

function createClient(): ShipyardApiClient & { createSession: ReturnType<typeof vi.fn> } {
  const createSession = vi.fn(async () => ({ token: 'fresh-token', expiresAt: inOneHour() }));
  return { createSession } as unknown as ShipyardApiClient & { createSession: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  window.sessionStorage.clear();
  signPersonalMessage.mockReset();
  signPersonalMessage.mockResolvedValue(`0x${'11'.repeat(65)}`);
});

describe('getStoredSessionToken', () => {
  it('returns null when nothing has been stored yet', () => {
    expect(getStoredSessionToken(ADDRESS)).toBeNull();
  });

  it('returns null rather than throwing when the stored value is not valid JSON', () => {
    window.sessionStorage.setItem(STORAGE_KEY, 'not-json{');
    expect(getStoredSessionToken(ADDRESS)).toBeNull();
  });

  it('returns null when the stored session is missing any of address, token, or expiresAt', () => {
    store({ address: ADDRESS, token: '', expiresAt: inOneHour() });
    expect(getStoredSessionToken(ADDRESS)).toBeNull();
  });

  /** The token authenticates one address. Handing it out after the customer switches accounts in
   * their wallet would sign the new account's requests as the old one. */
  it('refuses a token issued for a different address than the one now connected', () => {
    store({ address: OTHER_ADDRESS, token: 'other-token', expiresAt: inOneHour() });
    expect(getStoredSessionToken(ADDRESS)).toBeNull();
  });

  it('matches the stored address case-insensitively, since wallets vary on checksum casing', () => {
    store({ address: ADDRESS.toLowerCase(), token: 'token', expiresAt: inOneHour() });
    expect(getStoredSessionToken(ADDRESS.toUpperCase() as `0x${string}`)).toBe('token');
  });

  it('refuses an expired token instead of letting the gateway reject it', () => {
    store({ address: ADDRESS, token: 'stale', expiresAt: new Date(Date.now() - 1_000).toISOString() });
    expect(getStoredSessionToken(ADDRESS)).toBeNull();
  });

  it('still enforces expiry when no address is supplied to check against', () => {
    store({ address: ADDRESS, token: 'stale', expiresAt: new Date(Date.now() - 1_000).toISOString() });
    expect(getStoredSessionToken()).toBeNull();
  });

  it('returns a live token for the connected address', () => {
    store({ address: ADDRESS, token: 'live', expiresAt: inOneHour() });
    expect(getStoredSessionToken(ADDRESS)).toBe('live');
  });

  it('keeps GOAT and BOT backend sessions isolated', () => {
    store({ address: ADDRESS, token: 'goat-token', expiresAt: inOneHour() });
    window.sessionStorage.setItem(
      'shipyard402:session:bot-chain',
      JSON.stringify({ address: ADDRESS, token: 'bot-token', expiresAt: inOneHour() }),
    );

    expect(getStoredSessionToken(ADDRESS, 'goat')).toBe('goat-token');
    expect(getStoredSessionToken(ADDRESS, 'bot-chain')).toBe('bot-token');
  });
});

describe('ensureSession', () => {
  /** The whole point of the stored token: polling a run must not reopen MetaMask on every tick. */
  it('reuses a live token without asking the wallet to sign anything', async () => {
    store({ address: ADDRESS, token: 'live', expiresAt: inOneHour() });
    const client = createClient();

    await expect(ensureSession(client, ADDRESS)).resolves.toBe('live');
    expect(signPersonalMessage).not.toHaveBeenCalled();
    expect(client.createSession).not.toHaveBeenCalled();
  });

  it('signs the exact login message the gateway recovers the signer from', async () => {
    const client = createClient();
    const before = Math.floor(Date.now() / 1_000);

    await ensureSession(client, ADDRESS);

    const [address, message] = signPersonalMessage.mock.calls[0] as [string, string];
    expect(address).toBe(ADDRESS);
    const issuedAt = Number(/issued at: (\d+)$/.exec(message)?.[1]);
    expect(message).toBe(`Shipyard402 login\naddress: ${ADDRESS.toLowerCase()}\nissued at: ${issuedAt}`);
    expect(issuedAt).toBeGreaterThanOrEqual(before);
  });

  it('exchanges the signature for a token and stores it for later reads', async () => {
    const client = createClient();

    await expect(ensureSession(client, ADDRESS)).resolves.toBe('fresh-token');
    expect(client.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ address: ADDRESS, signature: `0x${'11'.repeat(65)}` }),
    );
    expect(getStoredSessionToken(ADDRESS)).toBe('fresh-token');
  });

  it('signs again when the stored token belongs to a different address', async () => {
    store({ address: OTHER_ADDRESS, token: 'other-token', expiresAt: inOneHour() });
    const client = createClient();

    await expect(ensureSession(client, ADDRESS)).resolves.toBe('fresh-token');
    expect(signPersonalMessage).toHaveBeenCalledTimes(1);
  });

  it('signs again when the stored token has expired', async () => {
    store({ address: ADDRESS, token: 'stale', expiresAt: new Date(Date.now() - 1_000).toISOString() });
    const client = createClient();

    await expect(ensureSession(client, ADDRESS)).resolves.toBe('fresh-token');
    expect(signPersonalMessage).toHaveBeenCalledTimes(1);
  });

  /** A rejected signature must leave no half-written session behind for the next read to trust. */
  it('stores nothing when the customer rejects the signature request', async () => {
    signPersonalMessage.mockRejectedValue(new Error('User rejected the request.'));
    const client = createClient();

    await expect(ensureSession(client, ADDRESS)).rejects.toThrow('User rejected');
    expect(client.createSession).not.toHaveBeenCalled();
    expect(getStoredSessionToken(ADDRESS)).toBeNull();
  });

  it('stores nothing when the gateway refuses to issue a token', async () => {
    const client = createClient();
    client.createSession.mockRejectedValue(new Error('LOGIN_SIGNATURE_INVALID'));

    await expect(ensureSession(client, ADDRESS)).rejects.toThrow('LOGIN_SIGNATURE_INVALID');
    expect(getStoredSessionToken(ADDRESS)).toBeNull();
  });
});

describe('clearStoredSession', () => {
  it('removes the stored token so the next call has to sign again', () => {
    store({ address: ADDRESS, token: 'live', expiresAt: inOneHour() });
    clearStoredSession();
    expect(getStoredSessionToken(ADDRESS)).toBeNull();
  });

  it('is safe to call when there is nothing stored', () => {
    expect(() => clearStoredSession()).not.toThrow();
  });
});
