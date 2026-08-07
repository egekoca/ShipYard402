import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';

import { issueSessionToken, loginMessage, verifyLoginSignature, verifySessionToken } from './session-auth.js';

const KEY = `0x${'11'.repeat(32)}` as const;
const ADDRESS = privateKeyToAccount(KEY).address;
const SECRET = 'test-session-secret';

describe('verifyLoginSignature', () => {
  it('accepts a fresh signature from the address it claims to be', async () => {
    const issuedAt = 1_800_000_000;
    const signature = await privateKeyToAccount(KEY).signMessage({ message: loginMessage(ADDRESS, issuedAt) });
    await expect(verifyLoginSignature({
      address: ADDRESS, signature, issuedAtEpochSeconds: issuedAt, nowEpochSeconds: issuedAt + 5,
    })).resolves.toBe(true);
  });

  it('rejects a signature that recovers to a different address than claimed', async () => {
    const issuedAt = 1_800_000_000;
    const impostorKey = `0x${'22'.repeat(32)}` as const;
    const signature = await privateKeyToAccount(impostorKey).signMessage({ message: loginMessage(ADDRESS, issuedAt) });
    await expect(verifyLoginSignature({
      address: ADDRESS, signature, issuedAtEpochSeconds: issuedAt, nowEpochSeconds: issuedAt + 5,
    })).resolves.toBe(false);
  });

  it('rejects a stale signature outside the validity window', async () => {
    const issuedAt = 1_800_000_000;
    const signature = await privateKeyToAccount(KEY).signMessage({ message: loginMessage(ADDRESS, issuedAt) });
    await expect(verifyLoginSignature({
      address: ADDRESS, signature, issuedAtEpochSeconds: issuedAt, nowEpochSeconds: issuedAt + 3_600,
    })).resolves.toBe(false);
  });

  it('rejects a malformed signature', async () => {
    await expect(verifyLoginSignature({
      address: ADDRESS, signature: `0x${'ab'.repeat(65)}`, issuedAtEpochSeconds: 1_800_000_000, nowEpochSeconds: 1_800_000_000,
    })).resolves.toBe(false);
  });
});

describe('session token issue/verify', () => {
  it('round-trips a freshly issued token', () => {
    const now = 1_800_000_000;
    const token = issueSessionToken(SECRET, ADDRESS, now, 3_600);
    expect(verifySessionToken(SECRET, token, now + 10)).toMatchObject({ address: ADDRESS.toLowerCase() });
  });

  it('rejects an expired token', () => {
    const now = 1_800_000_000;
    const token = issueSessionToken(SECRET, ADDRESS, now, 60);
    expect(verifySessionToken(SECRET, token, now + 120)).toBeNull();
  });

  it('rejects a token signed with a different secret', () => {
    const now = 1_800_000_000;
    const token = issueSessionToken('a-different-secret', ADDRESS, now, 3_600);
    expect(verifySessionToken(SECRET, token, now + 10)).toBeNull();
  });

  it('rejects a token with a tampered address', () => {
    const now = 1_800_000_000;
    const token = issueSessionToken(SECRET, ADDRESS, now, 3_600);
    const [, expiresAt, signature] = token.split('.');
    const tampered = `0x9999999999999999999999999999999999999a.${expiresAt}.${signature}`;
    expect(verifySessionToken(SECRET, tampered, now + 10)).toBeNull();
  });

  it('rejects a malformed token', () => {
    expect(verifySessionToken(SECRET, 'not-a-real-token', 1_800_000_000)).toBeNull();
  });
});
