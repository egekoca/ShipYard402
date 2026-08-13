import { describe, expect, it } from 'vitest';

import { assertControlledBnbRequirement } from './requirement-policy.js';
import { BNB_CANONICAL_USDC, BNB_CANONICAL_USDT, BNB_MAINNET_NETWORK } from './runtime-config.js';

const policy = {
  payTo: '0x4000000000000000000000000000000000000004',
  priceAtomic: '100000000000000',
  settlementAsset: BNB_CANONICAL_USDT,
} as const;

function requirement(overrides: Record<string, unknown> = {}) {
  return {
    scheme: 'exact',
    network: BNB_MAINNET_NETWORK,
    amount: policy.priceAtomic,
    asset: BNB_CANONICAL_USDT,
    payTo: policy.payTo,
    extra: { assetTransferMethod: 'permit2' },
    ...overrides,
  };
}

describe('controlled BNB facilitator policy', () => {
  it('allows only the configured settlement-asset Permit2 payment', () => {
    expect(() => assertControlledBnbRequirement(requirement(), policy)).not.toThrow();
  });

  it('allows a USDC payment when USDC is the configured settlement asset', () => {
    const usdcPolicy = { ...policy, settlementAsset: BNB_CANONICAL_USDC } as const;
    expect(() => assertControlledBnbRequirement(requirement({ asset: BNB_CANONICAL_USDC }), usdcPolicy)).not.toThrow();
    // ...and rejects USDT under a USDC policy: the asset must match exactly, not just be a stablecoin.
    expect(() => assertControlledBnbRequirement(requirement({ asset: BNB_CANONICAL_USDT }), usdcPolicy)).toThrow();
  });

  it.each([
    ['network', { network: 'eip155:8453' }],
    ['asset', { asset: '0x7000000000000000000000000000000000000007' }],
    ['recipient', { payTo: '0x8000000000000000000000000000000000000008' }],
    ['amount', { amount: '100000000000001' }],
    ['transfer method', { extra: { assetTransferMethod: 'eip3009' } }],
  ])('rejects an unreviewed %s', (_label, override) => {
    expect(() => assertControlledBnbRequirement(requirement(override), policy)).toThrow();
  });
});
