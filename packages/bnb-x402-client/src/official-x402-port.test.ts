import type { PaymentRequirements } from '@x402/core/types';
import { describe, expect, it } from 'vitest';

import { BNB_CANONICAL_USDT, BNB_MAINNET_NETWORK } from './constants.js';
import { createOfficialBnbX402PaidRequestPort, sameRequirement } from './official-x402-port.js';
import type { X402PaymentPolicy } from './requirement-policy.js';

const PAY_TO = '0x4000000000000000000000000000000000000004' as const;
const PAYER_KEY = `0x${'11'.repeat(32)}` as const;
const RPC_URL = 'https://bsc-rpc.example/never-called';

function requirement(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: 'exact',
    network: BNB_MAINNET_NETWORK,
    amount: '100000000000000',
    asset: BNB_CANONICAL_USDT,
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    extra: { assetTransferMethod: 'permit2' },
    ...overrides,
  } as PaymentRequirements;
}

const policy: X402PaymentPolicy = {
  network: BNB_MAINNET_NETWORK,
  allowedAssets: [BNB_CANONICAL_USDT],
  maximumAtomicAmount: '100000000000000',
};

/**
 * A target that answers one 402 challenge and is never actually paid. x402 v2 carries the challenge
 * in a base64 PAYMENT-REQUIRED header (the JSON-body form is v1 only), so this mirrors a real server.
 */
function challengeFetch(accepts: readonly PaymentRequirements[]): typeof fetch {
  const challenge = { x402Version: 2, resource: { url: 'https://target.example/paid/resource' }, accepts };
  return (async () =>
    new Response('{}', {
      status: 402,
      headers: {
        'content-type': 'application/json',
        'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(challenge), 'utf8').toString('base64'),
      },
    })) as unknown as typeof fetch;
}

function port(accepts: readonly PaymentRequirements[], policyOverrides: Partial<X402PaymentPolicy> = {}) {
  return createOfficialBnbX402PaidRequestPort({
    rpcUrl: RPC_URL,
    payerPrivateKey: PAYER_KEY,
    endpoint: 'https://target.example/paid/resource',
    policy: { ...policy, ...policyOverrides },
    fetchImplementation: challengeFetch(accepts),
  });
}

describe('official BNB x402 paid-request port', () => {
  it('quotes the terms a real target published rather than a configured tuple', async () => {
    const quoted = await port([
      requirement({ amount: '7', payTo: '0x9000000000000000000000000000000000000009' }),
    ]).quote();

    expect(quoted).toMatchObject({
      amountAtomic: '7',
      payTo: '0x9000000000000000000000000000000000000009',
      asset: BNB_CANONICAL_USDT,
      transferMethod: 'permit2',
    });
  });

  it('explains why a target is unpayable instead of failing opaquely', async () => {
    // The operator needs to tell "we do not hold that asset" apart from "it is too expensive".
    await expect(port([requirement({ asset: '0x7000000000000000000000000000000000000007' })]).quote()).rejects.toThrow(
      /ASSET_NOT_HELD/,
    );
  });

  it('rejects a target that answers with anything but a 402 challenge', async () => {
    const notCharging = createOfficialBnbX402PaidRequestPort({
      rpcUrl: RPC_URL,
      payerPrivateKey: PAYER_KEY,
      endpoint: 'https://target.example/paid/resource',
      policy,
      fetchImplementation: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
    });

    await expect(notCharging.quote()).rejects.toThrow(/received HTTP 200/);
  });

  it('refuses a plaintext endpoint, which would expose the payment header in transit', () => {
    expect(() =>
      createOfficialBnbX402PaidRequestPort({
        rpcUrl: RPC_URL,
        payerPrivateKey: PAYER_KEY,
        endpoint: 'http://target.example/paid/resource',
        policy,
      }),
    ).toThrow(/must use HTTPS/);
  });
});

describe('sameRequirement', () => {
  it('matches an offer against itself', () => {
    expect(sameRequirement(requirement(), requirement())).toBe(true);
  });

  it('ignores address casing, which differs freely between servers', () => {
    expect(sameRequirement(requirement(), requirement({ payTo: PAY_TO.toUpperCase() as `0x${string}` }))).toBe(true);
  });

  it.each([{ amount: '1' }, { asset: '0x7000000000000000000000000000000000000007' }, { network: 'eip155:8453' }])(
    'separates offers that differ economically %#',
    (override) => {
      expect(sameRequirement(requirement(), requirement(override))).toBe(false);
    },
  );
});
