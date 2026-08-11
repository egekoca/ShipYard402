import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';

import { buildExactEvmRequirements, decodePaymentHeader, verifyExactEvmPayment, X402_VERSION } from './exact-evm.js';
import { acquireExactEvmPayment, X402NegotiationError } from './payer-client.js';

const CHAIN_ID = 48816;
const ASSET = '0x1111111111111111111111111111111111111111' as const;
const PAY_TO = '0x2222222222222222222222222222222222222222' as const;
const payer = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const NONCE = `0x${'ab'.repeat(32)}` as const;

/** A fetch that answers one paid URL with a real 402 challenge carrying the given accepts array. */
function challengeFetch(accepts: unknown[], status = 402): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ x402Version: X402_VERSION, accepts, error: 'PAYMENT_REQUIRED' }), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

function acceptsFor(amount: string, chainId = CHAIN_ID): unknown {
  return buildExactEvmRequirements({
    chainId,
    amountAtomic: amount,
    resource: 'http://target/paid/resource',
    payTo: PAY_TO,
    asset: ASSET,
    tokenName: 'Shipyard Testnet Token',
    tokenVersion: '1',
  });
}

async function acquire(fetchImpl: typeof fetch, overrides: Partial<Parameters<typeof acquireExactEvmPayment>[0]> = {}) {
  const nowSec = 1_800_000_000;
  return acquireExactEvmPayment({
    endpoint: 'http://target/paid/resource',
    from: payer.address,
    nonce: NONCE,
    validAfterSec: nowSec - 10,
    validBeforeSec: nowSec + 300,
    signTypedData: (args) => payer.signTypedData(args),
    maxAmountAtomic: '5000',
    expectedChainId: CHAIN_ID,
    allowedAssets: [ASSET],
    fetchImpl,
    ...overrides,
  });
}

describe('acquireExactEvmPayment — real 402 negotiation', () => {
  it('signs an X-PAYMENT the resource server then accepts (buyer <-> server interop)', async () => {
    const acquired = await acquire(challengeFetch([acceptsFor('1000')]));
    expect(acquired.requirements.maxAmountRequired).toBe('1000');

    // The produced header must verify against the same requirements the server would rebuild.
    const header = decodePaymentHeader(acquired.paymentHeader);
    expect(header).not.toBeNull();
    const verification = await verifyExactEvmPayment({
      header: header!,
      requirements: acquired.requirements,
      nowSec: 1_800_000_000,
    });
    expect(verification.valid).toBe(true);
    expect(verification.signer?.toLowerCase()).toBe(payer.address.toLowerCase());
  });

  it('pays exactly the advertised amount, using the caller-owned nonce', async () => {
    const acquired = await acquire(challengeFetch([acceptsFor('1500')]));
    expect(acquired.authorization.value).toBe('1500');
    expect(acquired.authorization.nonce).toBe(NONCE);
    expect(acquired.authorization.to.toLowerCase()).toBe(PAY_TO);
  });

  it('refuses to sign when the server asks for more than the budget ceiling', async () => {
    await expect(acquire(challengeFetch([acceptsFor('9000')]))).rejects.toMatchObject({
      name: 'X402NegotiationError',
      code: 'AMOUNT_OVER_BUDGET',
    });
  });

  it('rejects a challenge with no requirement on the payer chain', async () => {
    await expect(acquire(challengeFetch([acceptsFor('1000', 1)]))).rejects.toMatchObject({
      code: 'NO_PAYABLE_REQUIREMENT',
    });
  });

  it('rejects a non-402 response instead of paying', async () => {
    await expect(acquire(challengeFetch([acceptsFor('1000')], 200))).rejects.toMatchObject({
      code: 'UNEXPECTED_STATUS',
    });
  });

  it('rejects an empty accepts array', async () => {
    await expect(acquire(challengeFetch([]))).rejects.toBeInstanceOf(X402NegotiationError);
  });

  it('skips a malformed requirement and uses the next payable one', async () => {
    const good = acceptsFor('1200');
    const acquired = await acquire(challengeFetch([{ scheme: 'exact', network: 'eip155:48816' }, good]));
    expect(acquired.requirements.maxAmountRequired).toBe('1200');
  });
});

describe('asset allowlist', () => {
  const OTHER_ASSET = '0x9999999999999999999999999999999999999999' as const;

  it('refuses to sign for an asset the operator did not allow', async () => {
    // The 402 body is written by the target, which for a marketplace run is a service the customer
    // chose. Without this filter the payer would sign an EIP-3009 authorization whose verifying
    // contract is whatever address that target named -- a blind signature against any contract on
    // the chain sharing the TransferWithAuthorization typehash.
    const hostile = buildExactEvmRequirements({
      chainId: CHAIN_ID,
      amountAtomic: '1000',
      resource: 'http://target/paid/resource',
      payTo: PAY_TO,
      asset: OTHER_ASSET,
      tokenName: 'Wrapped Bitcoin',
      tokenVersion: '1',
    });
    await expect(acquire(challengeFetch([hostile]))).rejects.toMatchObject({ code: 'NO_PAYABLE_REQUIREMENT' });
  });

  it('picks the allowed asset when the challenge offers several', async () => {
    const hostile = buildExactEvmRequirements({
      chainId: CHAIN_ID,
      amountAtomic: '1000',
      resource: 'http://target/paid/resource',
      payTo: PAY_TO,
      asset: OTHER_ASSET,
      tokenName: 'Wrapped Bitcoin',
      tokenVersion: '1',
    });
    const acquired = await acquire(challengeFetch([hostile, acceptsFor('1000')]));
    expect(acquired.requirements.asset).toBe(ASSET);
  });

  it('matches the allowlist regardless of address casing', async () => {
    const acquired = await acquire(challengeFetch([acceptsFor('1000')]), {
      allowedAssets: [ASSET.toUpperCase().replace('0X', '0x') as `0x${string}`],
    });
    expect(acquired.requirements.asset).toBe(ASSET);
  });
});
