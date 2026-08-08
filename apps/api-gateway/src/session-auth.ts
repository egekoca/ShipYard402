import { createHmac, timingSafeEqual } from 'node:crypto';

import { recoverMessageAddress } from 'viem';

const LOGIN_SIGNATURE_VALIDITY_SECONDS = 300;

/**
 * The message a wallet signs once, right after connecting, to prove control of its address before
 * the gateway will issue a session token. issuedAt is checked against the current time (not
 * stored/tracked for reuse) so a stale, long-since-leaked signature can't mint a fresh token --
 * this is a login proof, not a per-request signature.
 */
export function loginMessage(address: string, issuedAtEpochSeconds: number): string {
  return `Shipyard402 login\naddress: ${address.toLowerCase()}\nissued at: ${issuedAtEpochSeconds}`;
}

export async function verifyLoginSignature(
  input: Readonly<{
    address: `0x${string}`;
    signature: `0x${string}`;
    issuedAtEpochSeconds: number;
    nowEpochSeconds: number;
  }>,
): Promise<boolean> {
  if (Math.abs(input.nowEpochSeconds - input.issuedAtEpochSeconds) > LOGIN_SIGNATURE_VALIDITY_SECONDS) return false;
  let recovered: `0x${string}`;
  try {
    recovered = await recoverMessageAddress({
      message: loginMessage(input.address, input.issuedAtEpochSeconds),
      signature: input.signature,
    });
  } catch {
    return false;
  }
  return recovered.toLowerCase() === input.address.toLowerCase();
}

export type Session = Readonly<{ address: `0x${string}`; expiresAtEpochSeconds: number }>;

/**
 * A stateless bearer token: `${address}.${expiresAt}.${hmac}` signed with a server secret. No
 * session store needed -- verification is just recomputing and comparing the HMAC, which is why
 * SESSION_SIGNING_SECRET must never be logged or exposed (anyone holding it can mint a token for
 * any address).
 */
export function issueSessionToken(
  secret: string,
  address: `0x${string}`,
  nowEpochSeconds: number,
  validitySeconds: number,
): string {
  const expiresAtEpochSeconds = nowEpochSeconds + validitySeconds;
  const payload = `${address.toLowerCase()}.${expiresAtEpochSeconds}`;
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function verifySessionToken(secret: string, token: string, nowEpochSeconds: number): Session | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [address, expiresAtRaw, signature] = parts;
  if (!address || !expiresAtRaw || !signature || !/^0x[a-fA-F0-9]{40}$/.test(address)) return null;
  const expiresAtEpochSeconds = Number.parseInt(expiresAtRaw, 10);
  if (!Number.isInteger(expiresAtEpochSeconds)) return null;

  const expected = createHmac('sha256', secret).update(`${address}.${expiresAtRaw}`).digest('base64url');
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(signature);
  if (expectedBuffer.length !== actualBuffer.length || !timingSafeEqual(expectedBuffer, actualBuffer)) return null;

  if (nowEpochSeconds >= expiresAtEpochSeconds) return null;
  return { address: address as `0x${string}`, expiresAtEpochSeconds };
}
