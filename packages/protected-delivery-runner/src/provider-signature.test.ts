import { Wallet } from 'ethers';
import { describe, expect, it } from 'vitest';

import { verifyResponseSignature } from './provider-signature.js';

describe('verifyResponseSignature', () => {
  const wallet = new Wallet(`0x${'22'.repeat(32)}`);
  const responseBodyHash = `0x${'aa'.repeat(32)}` as const;

  it('accepts a real signature from the expected signer', async () => {
    const signature = (await wallet.signMessage(Buffer.from(responseBodyHash.slice(2), 'hex'))) as `0x${string}`;
    expect(verifyResponseSignature(responseBodyHash, signature, wallet.address as `0x${string}`)).toBe(true);
  });

  it('rejects a valid signature from a different signer than expected', async () => {
    const signature = (await wallet.signMessage(Buffer.from(responseBodyHash.slice(2), 'hex'))) as `0x${string}`;
    const someoneElse = '0x2000000000000000000000000000000000000002' as const;
    expect(verifyResponseSignature(responseBodyHash, signature, someoneElse)).toBe(false);
  });

  it('rejects a signature over a different hash than what was actually presented', async () => {
    const otherHash = `0x${'bb'.repeat(32)}` as const;
    const signature = (await wallet.signMessage(Buffer.from(otherHash.slice(2), 'hex'))) as `0x${string}`;
    expect(verifyResponseSignature(responseBodyHash, signature, wallet.address as `0x${string}`)).toBe(false);
  });

  it('rejects when no signature is present', () => {
    expect(verifyResponseSignature(responseBodyHash, undefined, wallet.address as `0x${string}`)).toBe(false);
  });

  it('rejects a malformed signature rather than throwing', () => {
    expect(
      verifyResponseSignature(
        responseBodyHash,
        '0xnot-a-real-signature' as `0x${string}`,
        wallet.address as `0x${string}`,
      ),
    ).toBe(false);
  });
});
