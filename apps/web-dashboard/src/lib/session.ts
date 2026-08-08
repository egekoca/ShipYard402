import type { ShipyardApiClient } from '@shipyard402/public-api-client';

import { signPersonalMessage } from './goat-wallet';

const STORAGE_KEY = 'shipyard402:session';
// Must match apps/api-gateway's session-auth.ts loginMessage() exactly -- the server recovers the
// signer from this exact string and rejects the login if it doesn't match.
function loginMessage(address: string, issuedAtEpochSeconds: number): string {
  return `Shipyard402 login\naddress: ${address.toLowerCase()}\nissued at: ${issuedAtEpochSeconds}`;
}

type StoredSession = Readonly<{ address: `0x${string}`; token: string; expiresAt: string }>;

function readStoredSession(): StoredSession | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (!parsed.address || !parsed.token || !parsed.expiresAt) return null;
    return parsed as StoredSession;
  } catch {
    return null;
  }
}

function writeStoredSession(session: StoredSession): void {
  if (typeof window === 'undefined') return;
  window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

/** Read by ShipyardApiClient on every request -- see its getSessionToken constructor param. Only
 * returns a token that is both unexpired and issued for the currently connected address. */
export function getStoredSessionToken(address?: `0x${string}` | null): string | null {
  const stored = readStoredSession();
  if (!stored) return null;
  if (address && stored.address.toLowerCase() !== address.toLowerCase()) return null;
  if (Date.parse(stored.expiresAt) <= Date.now()) return null;
  return stored.token;
}

/**
 * One MetaMask signature per address per browser session (sessionStorage, not localStorage --
 * cleared when the tab closes) instead of one per API call, which is what makes polling usable.
 * A no-op if a valid token for this exact address is already stored.
 */
export async function ensureSession(client: ShipyardApiClient, address: `0x${string}`): Promise<string> {
  const existing = getStoredSessionToken(address);
  if (existing) return existing;

  const issuedAt = Math.floor(Date.now() / 1_000);
  const signature = await signPersonalMessage(address, loginMessage(address, issuedAt));
  const session = await client.createSession({ address, signature, issuedAt });
  writeStoredSession({ address, token: session.token, expiresAt: session.expiresAt });
  return session.token;
}

export function clearStoredSession(): void {
  if (typeof window === 'undefined') return;
  window.sessionStorage.removeItem(STORAGE_KEY);
}
