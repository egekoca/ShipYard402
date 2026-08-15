import { describe, expect, it } from 'vitest';

import { chainSafeCompletionTime } from './ethers-adapters.js';
import type { RunAttestationInput } from './ports.js';

function attestation(completedAt: number): RunAttestationInput {
  return {
    runId: `0x${'11'.repeat(32)}`,
    targetAgentId: 1n,
    targetServiceId: `0x${'22'.repeat(32)}`,
    targetVersionHash: `0x${'33'.repeat(32)}`,
    policyHash: `0x${'44'.repeat(32)}`,
    customerPaymentProofHash: `0x${'55'.repeat(32)}`,
    toolReceiptRoot: `0x${'66'.repeat(32)}`,
    evidenceRoot: `0x${'77'.repeat(32)}`,
    evidenceURI: 'ipfs://bafkrei',
    requester: '0x146CD395C3f25fc6E3C94180109baD6C9786C126',
    shipyardAgent: '0x0fb8aad3bDd981E47E8b7f914a88bcbAdDd31cE2',
    customerPaymentToken: '0x1213319c60D2749409BBeA32e79450464F5dFd09',
    toolSpendToken: '0x0000000000000000000000000000000000000000',
    customerPayment: 1_421_052n,
    toolSpend: 0n,
    completedAt,
    expiresAt: completedAt + 2_592_000,
    result: 'PASS',
  };
}

describe('chainSafeCompletionTime', () => {
  it('leaves a completion the chain has already reached untouched', () => {
    const input = attestation(1_799_999_990);
    expect(chainSafeCompletionTime(input, 1_800_000_000)).toBe(input);
  });

  it('never reports a completion ahead of the chain clock', () => {
    // ShipyardRunRegistry reverts with InvalidCompletionTime when completedAt > block.timestamp.
    // A wall-clock completion does exactly that whenever the chain has not produced a block for a
    // second or two, so a valid attestation would revert purely on block timing.
    const clamped = chainSafeCompletionTime(attestation(1_800_000_007), 1_800_000_000);
    expect(clamped.completedAt).toBe(1_800_000_000);
  });

  it('keeps the expiry window intact when it clamps', () => {
    const input = attestation(1_800_000_007);
    const clamped = chainSafeCompletionTime(input, 1_800_000_000);
    expect(clamped.expiresAt).toBe(input.expiresAt);
    expect(clamped.expiresAt).toBeGreaterThan(clamped.completedAt);
  });
});
