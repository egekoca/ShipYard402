import type { PaymentRequirements } from '@x402/core/types';
import { describe, expect, it } from 'vitest';

import { BNB_CANONICAL_USDC, BNB_CANONICAL_USDT, BNB_MAINNET_NETWORK, BNB_USD1 } from './constants.js';
import { describeRejections, selectPayableRequirement, type X402PaymentPolicy } from './requirement-policy.js';

const PAY_TO = '0x4000000000000000000000000000000000000004' as const;
const OTHER_PAY_TO = '0x8000000000000000000000000000000000000008' as const;
const AMOUNT = '100000000000000';

function requirement(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: 'exact',
    network: BNB_MAINNET_NETWORK,
    amount: AMOUNT,
    asset: BNB_CANONICAL_USDT,
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    extra: { assetTransferMethod: 'permit2' },
    ...overrides,
  } as PaymentRequirements;
}

function policy(overrides: Partial<X402PaymentPolicy> = {}): X402PaymentPolicy {
  return {
    network: BNB_MAINNET_NETWORK,
    allowedAssets: [BNB_CANONICAL_USDT],
    maximumAtomicAmount: AMOUNT,
    ...overrides,
  };
}

function codesFor(override: Partial<PaymentRequirements>, policyOverrides: Partial<X402PaymentPolicy> = {}) {
  const selection = selectPayableRequirement([requirement(override)], policy(policyOverrides));
  expect(selection.payable).toBeUndefined();
  return selection.rejected[0]?.codes ?? [];
}

describe('selectPayableRequirement', () => {
  it('accepts a challenge that fits inside every limit, taking its terms from the challenge', () => {
    const selection = selectPayableRequirement([requirement()], policy());

    expect(selection.payable).toMatchObject({
      amountAtomic: AMOUNT,
      asset: BNB_CANONICAL_USDT,
      payTo: PAY_TO,
      transferMethod: 'permit2',
    });
  });

  it('pays a price below the ceiling, rather than only an exact configured amount', () => {
    // This is the point of the ceiling: a service that lowers its price stays payable.
    const selection = selectPayableRequirement([requirement({ amount: '1' })], policy());

    expect(selection.payable?.amountAtomic).toBe('1');
  });

  it('pays whatever recipient the service publishes when none is pinned', () => {
    const selection = selectPayableRequirement([requirement({ payTo: OTHER_PAY_TO })], policy());

    expect(selection.payable?.payTo).toBe(OTHER_PAY_TO);
  });

  it('honours a pinned recipient, so a controlled target stays controlled', () => {
    expect(codesFor({ payTo: OTHER_PAY_TO }, { payTo: PAY_TO })).toEqual(['RECIPIENT_NOT_PINNED']);
  });

  it('treats a missing assetTransferMethod as EIP-3009, matching the scheme default', () => {
    const selection = selectPayableRequirement(
      [requirement({ extra: null, asset: '0x7000000000000000000000000000000000000007' })],
      policy({ allowedAssets: ['0x7000000000000000000000000000000000000007'] }),
    );

    expect(selection.payable?.transferMethod).toBe('eip3009');
  });

  it('accepts EIP-3009 now, which the old fixed policy rejected outright', () => {
    const selection = selectPayableRequirement(
      [requirement({ extra: { assetTransferMethod: 'eip3009' }, asset: '0x7000000000000000000000000000000000000007' })],
      policy({ allowedAssets: ['0x7000000000000000000000000000000000000007'] }),
    );

    expect(selection.payable?.transferMethod).toBe('eip3009');
  });

  it('refuses EIP-3009 over canonical BNB USDT, which has no transferWithAuthorization', () => {
    // Signing this would produce an authorization the token itself can never settle.
    expect(codesFor({ extra: { assetTransferMethod: 'eip3009' } })).toEqual(['ASSET_DOES_NOT_SUPPORT_EIP3009']);
  });

  it('accepts EIP-3009 over USD1, the one BNB asset that actually implements it', () => {
    // Verified against BNB mainnet: USD1 exposes DOMAIN_SEPARATOR and authorizationState, so an
    // EIP-3009 authorization over it can genuinely settle -- unlike over USDT or USDC.
    const selection = selectPayableRequirement(
      [requirement({ asset: BNB_USD1, extra: { assetTransferMethod: 'eip3009' } })],
      policy({ allowedAssets: [BNB_USD1] }),
    );

    expect(selection.payable?.transferMethod).toBe('eip3009');
  });

  it('refuses permit2-exact, which live services publish but the client library cannot sign yet', () => {
    expect(codesFor({ extra: { assetTransferMethod: 'permit2-exact' } })).toEqual(['TRANSFER_METHOD_UNSUPPORTED']);
  });

  it('refuses a transfer method the client library cannot sign', () => {
    expect(codesFor({ extra: { assetTransferMethod: 'permit2-upto' } })).toEqual(['TRANSFER_METHOD_UNSUPPORTED']);
  });

  it('refuses an asset the payer does not hold, however legitimate it is', () => {
    // USDC is a real asset; it is simply not what this bridge route delivered.
    expect(codesFor({ asset: BNB_CANONICAL_USDC })).toEqual(['ASSET_NOT_HELD']);
  });

  it('refuses a price above the ceiling', () => {
    expect(codesFor({ amount: '100000000000001' })).toEqual(['AMOUNT_ABOVE_CEILING']);
  });

  it('refuses another chain, even for an asset we hold here', () => {
    expect(codesFor({ network: 'eip155:8453' })).toEqual(['NETWORK_NOT_ALLOWED']);
  });

  it('refuses a scheme other than exact', () => {
    expect(codesFor({ scheme: 'upto' })).toEqual(['SCHEME_NOT_EXACT']);
  });

  it('refuses a malformed amount rather than coercing it', () => {
    expect(codesFor({ amount: '1.5' })).toEqual(['AMOUNT_MALFORMED']);
  });

  it('reports every reason an entry failed, not just the first', () => {
    const codes = codesFor({ network: 'eip155:8453', amount: '100000000000001', asset: BNB_CANONICAL_USDC });

    expect(codes).toEqual(expect.arrayContaining(['NETWORK_NOT_ALLOWED', 'ASSET_NOT_HELD', 'AMOUNT_ABOVE_CEILING']));
  });

  it('walks past unpayable entries to the payable one in the same challenge', () => {
    const selection = selectPayableRequirement(
      [requirement({ network: 'eip155:8453' }), requirement({ amount: '50' })],
      policy(),
    );

    expect(selection.payable?.amountAtomic).toBe('50');
    expect(selection.rejected).toEqual([{ index: 0, codes: ['NETWORK_NOT_ALLOWED'] }]);
  });

  it('reads a v1 challenge’s maxAmountRequired as the price', () => {
    const v1 = { ...requirement(), maxAmountRequired: '42' } as unknown as PaymentRequirements;
    delete (v1 as unknown as Record<string, unknown>)['amount'];

    expect(selectPayableRequirement([v1], policy()).payable?.amountAtomic).toBe('42');
  });

  it('says so plainly when a challenge offered nothing at all', () => {
    const selection = selectPayableRequirement([], policy());

    expect(selection.payable).toBeUndefined();
    expect(describeRejections(selection.rejected)).toMatch(/no payment options/);
  });
});
