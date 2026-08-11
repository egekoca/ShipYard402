import {
  buildExactEvmRequirements,
  eip155Network,
  encodePaymentHeader,
  signExactEvmAuthorization,
  X402_VERSION,
  type ExactEvmPayload,
  type ExactEvmRequirements,
} from '@shipyard402/x402-payments';
import { afterEach, describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';

import { createDemoTargetApp, PAID_RESOURCE_ROUTE, PAYMENT_RESPONSE_HEADER, type DemoTargetMode } from './app.js';
import { SettlementError, type X402Settler } from './settler.js';

const CHAIN_ID = 48816;
const ASSET = '0x1111111111111111111111111111111111111111' as const;
const PAY_TO = '0x2222222222222222222222222222222222222222' as const;
const AMOUNT = '1000';
const TOKEN_NAME = 'Shipyard Testnet Token';
const TOKEN_VERSION = '1';
const payer = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');

/** Stands in for the EIP-3009 token at settlement: succeeds once per (from, nonce), then reverts as
 * ALREADY_SETTLED -- exactly the on-chain replay guard the Foundry test proves the real token has. */
class FakeSettler implements X402Settler {
  readonly used = new Set<string>();
  unavailable = false;

  async settle(payload: ExactEvmPayload): Promise<Readonly<{ transactionHash: `0x${string}` }>> {
    if (this.unavailable) throw new SettlementError('SETTLEMENT_UNAVAILABLE', 'settler down');
    const key = `${payload.authorization.from}:${payload.authorization.nonce}`.toLowerCase();
    if (this.used.has(key)) throw new SettlementError('ALREADY_SETTLED', 'authorization already used');
    this.used.add(key);
    return { transactionHash: `0x${'ab'.repeat(32)}` };
  }
}

const requirements: ExactEvmRequirements = buildExactEvmRequirements({
  chainId: CHAIN_ID,
  amountAtomic: AMOUNT,
  resource: 'http://localhost/paid/resource',
  payTo: PAY_TO,
  asset: ASSET,
  tokenName: TOKEN_NAME,
  tokenVersion: TOKEN_VERSION,
});

async function paymentHeader(
  overrides: Partial<{ nonce: `0x${string}`; tamperValue: string; validAfterSec: number; validBeforeSec: number }> = {},
): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = await signExactEvmAuthorization({
    requirements,
    from: payer.address,
    nonce: overrides.nonce ?? `0x${randomNonce()}`,
    validAfterSec: overrides.validAfterSec ?? nowSec - 60,
    validBeforeSec: overrides.validBeforeSec ?? nowSec + 600,
    signTypedData: (args) => payer.signTypedData(args),
  });
  const finalPayload: ExactEvmPayload = overrides.tamperValue
    ? { ...payload, authorization: { ...payload.authorization, value: overrides.tamperValue } }
    : payload;
  return encodePaymentHeader({
    x402Version: X402_VERSION,
    scheme: 'exact',
    network: eip155Network(CHAIN_ID),
    payload: finalPayload,
  });
}

function randomNonce(): string {
  let out = '';
  for (let i = 0; i < 64; i += 1) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}

function makeApp(mode: DemoTargetMode, settler: X402Settler) {
  return createDemoTargetApp({
    mode,
    payment: {
      chainId: CHAIN_ID,
      asset: ASSET,
      payTo: PAY_TO,
      amountAtomic: AMOUNT,
      tokenName: TOKEN_NAME,
      tokenVersion: TOKEN_VERSION,
      settler,
    },
  });
}

let app: ReturnType<typeof createDemoTargetApp> | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('x402 demo target — the 402 challenge', () => {
  it('answers an unpaid request with a 402 carrying real payment requirements', async () => {
    app = makeApp('V2_PROTECTED', new FakeSettler());
    const response = await app.inject({ method: 'GET', url: PAID_RESOURCE_ROUTE });
    expect(response.statusCode).toBe(402);
    const body = response.json();
    expect(body.error).toBe('PAYMENT_REQUIRED');
    expect(body.accepts[0]).toMatchObject({ scheme: 'exact', network: 'eip155:48816', maxAmountRequired: AMOUNT });
    expect(body.accepts[0].payTo.toLowerCase()).toBe(PAY_TO);
  });

  it('rejects a malformed X-PAYMENT header without touching settlement', async () => {
    const settler = new FakeSettler();
    app = makeApp('V2_PROTECTED', settler);
    const response = await app.inject({
      method: 'GET',
      url: PAID_RESOURCE_ROUTE,
      headers: { 'x-payment': 'not-a-valid-header' },
    });
    expect(response.statusCode).toBe(402);
    expect(response.json().error).toBe('MALFORMED_PAYMENT_HEADER');
    expect(settler.used.size).toBe(0);
  });

  it('rejects a forged payment (amount raised after signing) in both modes', async () => {
    for (const mode of ['V1_VULNERABLE', 'V2_PROTECTED'] as const) {
      const settler = new FakeSettler();
      app = makeApp(mode, settler);
      const header = await paymentHeader({ tamperValue: '999999' });
      const response = await app.inject({
        method: 'GET',
        url: PAID_RESOURCE_ROUTE,
        headers: { 'x-payment': header },
      });
      expect(response.statusCode).toBe(402);
      expect(response.json().error).toBe('INVALID_PAYMENT');
      expect(settler.used.size).toBe(0);
      await app.close();
    }
  });
});

describe('x402 demo target — settlement and delivery', () => {
  it('V2 settles a valid payment on-chain and delivers with a settlement receipt header', async () => {
    const settler = new FakeSettler();
    app = makeApp('V2_PROTECTED', settler);
    const header = await paymentHeader();
    const response = await app.inject({ method: 'GET', url: PAID_RESOURCE_ROUTE, headers: { 'x-payment': header } });
    expect(response.statusCode).toBe(200);
    expect(response.json().deliveryConfirmed).toBe(true);
    expect(response.headers[PAYMENT_RESPONSE_HEADER]).toBeDefined();
    expect(settler.used.size).toBe(1);
  });

  it('V2 rejects a replayed payment as already settled and does not deliver twice', async () => {
    const settler = new FakeSettler();
    app = makeApp('V2_PROTECTED', settler);
    const header = await paymentHeader({ nonce: `0x${'cd'.repeat(32)}` });

    const first = await app.inject({ method: 'GET', url: PAID_RESOURCE_ROUTE, headers: { 'x-payment': header } });
    expect(first.statusCode).toBe(200);

    const replay = await app.inject({ method: 'GET', url: PAID_RESOURCE_ROUTE, headers: { 'x-payment': header } });
    expect(replay.statusCode).toBe(409);
    expect(replay.json().error).toBe('PAYMENT_ALREADY_SETTLED');
  });

  it('V2 does not deliver when settlement is unavailable', async () => {
    const settler = new FakeSettler();
    settler.unavailable = true;
    app = makeApp('V2_PROTECTED', settler);
    const header = await paymentHeader();
    const response = await app.inject({ method: 'GET', url: PAID_RESOURCE_ROUTE, headers: { 'x-payment': header } });
    expect(response.statusCode).toBe(402);
    expect(response.json().error).toBe('SETTLEMENT_FAILED');
  });
});

describe('x402 demo target — the V1 vulnerability', () => {
  it('V1 delivers a replayed payment a second time even though its settlement reverts', async () => {
    const settler = new FakeSettler();
    app = makeApp('V1_VULNERABLE', settler);
    const header = await paymentHeader({ nonce: `0x${'ef'.repeat(32)}` });

    const first = await app.inject({ method: 'GET', url: PAID_RESOURCE_ROUTE, headers: { 'x-payment': header } });
    expect(first.statusCode).toBe(200);
    expect(first.json().deliveryConfirmed).toBe(true);

    // The bug: the same X-PAYMENT is honored again, because V1 delivers on a valid signature without
    // requiring the settlement (which now reverts as already-used) to succeed.
    const replay = await app.inject({ method: 'GET', url: PAID_RESOURCE_ROUTE, headers: { 'x-payment': header } });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().deliveryConfirmed).toBe(true);
  });

  it('V1 delivers even when settlement is entirely unavailable (trusts the header)', async () => {
    const settler = new FakeSettler();
    settler.unavailable = true;
    app = makeApp('V1_VULNERABLE', settler);
    const header = await paymentHeader();
    const response = await app.inject({ method: 'GET', url: PAID_RESOURCE_ROUTE, headers: { 'x-payment': header } });
    expect(response.statusCode).toBe(200);
    expect(response.json().deliveryConfirmed).toBe(true);
  });
});
