import { afterEach, describe, expect, it } from 'vitest';

import { createDemoTargetApp, PAID_RESOURCE_ROUTE } from './app.js';
import { issueDemoReceipt } from './receipt.js';

const SECRET = 'a'.repeat(32);
const NOW = new Date('2026-08-05T00:00:00.000Z');

describe('x402 demo target app', () => {
  let app: ReturnType<typeof createDemoTargetApp> | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('rejects a request with no payment receipt', async () => {
    app = createDemoTargetApp({ mode: 'V1_VULNERABLE', receiptSecret: SECRET, now: () => NOW });
    const response = await app.inject({ method: 'GET', url: PAID_RESOURCE_ROUTE });
    expect(response.statusCode).toBe(402);
  });

  it('rejects an invalid payment receipt', async () => {
    app = createDemoTargetApp({ mode: 'V1_VULNERABLE', receiptSecret: SECRET, now: () => NOW });
    const response = await app.inject({
      method: 'GET',
      url: PAID_RESOURCE_ROUTE,
      headers: { 'x-payment-receipt': 'garbage' },
    });
    expect(response.statusCode).toBe(402);
  });

  it('V1_VULNERABLE: delivers the resource on the first presentation and again on replay', async () => {
    app = createDemoTargetApp({ mode: 'V1_VULNERABLE', receiptSecret: SECRET, now: () => NOW });
    const token = issueDemoReceipt(
      { orderId: 'v1-order', atomicAmount: '1000', resource: PAID_RESOURCE_ROUTE, validForSeconds: 60 },
      SECRET,
      NOW,
    );

    const first = await app.inject({ method: 'GET', url: PAID_RESOURCE_ROUTE, headers: { 'x-payment-receipt': token } });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ deliveryConfirmed: true });

    const replay = await app.inject({ method: 'GET', url: PAID_RESOURCE_ROUTE, headers: { 'x-payment-receipt': token } });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ deliveryConfirmed: true });
  });

  it('V2_PROTECTED: delivers the resource once, then rejects the same receipt as already redeemed', async () => {
    app = createDemoTargetApp({ mode: 'V2_PROTECTED', receiptSecret: SECRET, now: () => NOW });
    const token = issueDemoReceipt(
      { orderId: 'v2-order', atomicAmount: '1000', resource: PAID_RESOURCE_ROUTE, validForSeconds: 60 },
      SECRET,
      NOW,
    );

    const first = await app.inject({ method: 'GET', url: PAID_RESOURCE_ROUTE, headers: { 'x-payment-receipt': token } });
    expect(first.statusCode).toBe(200);

    const replay = await app.inject({ method: 'GET', url: PAID_RESOURCE_ROUTE, headers: { 'x-payment-receipt': token } });
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toMatchObject({ error: 'PAYMENT_RECEIPT_ALREADY_REDEEMED' });
  });

  it('V2_PROTECTED: two different orders each redeem successfully once', async () => {
    app = createDemoTargetApp({ mode: 'V2_PROTECTED', receiptSecret: SECRET, now: () => NOW });
    const tokenA = issueDemoReceipt(
      { orderId: 'order-a', atomicAmount: '1000', resource: PAID_RESOURCE_ROUTE, validForSeconds: 60 },
      SECRET,
      NOW,
    );
    const tokenB = issueDemoReceipt(
      { orderId: 'order-b', atomicAmount: '1000', resource: PAID_RESOURCE_ROUTE, validForSeconds: 60 },
      SECRET,
      NOW,
    );

    const responseA = await app.inject({ method: 'GET', url: PAID_RESOURCE_ROUTE, headers: { 'x-payment-receipt': tokenA } });
    const responseB = await app.inject({ method: 'GET', url: PAID_RESOURCE_ROUTE, headers: { 'x-payment-receipt': tokenB } });
    expect(responseA.statusCode).toBe(200);
    expect(responseB.statusCode).toBe(200);
  });

  it('rejects a receipt issued for a different resource', async () => {
    app = createDemoTargetApp({ mode: 'V2_PROTECTED', receiptSecret: SECRET, now: () => NOW });
    const token = issueDemoReceipt(
      { orderId: 'wrong-resource-order', atomicAmount: '1000', resource: '/paid/other', validForSeconds: 60 },
      SECRET,
      NOW,
    );
    const response = await app.inject({ method: 'GET', url: PAID_RESOURCE_ROUTE, headers: { 'x-payment-receipt': token } });
    expect(response.statusCode).toBe(402);
    expect(response.json()).toMatchObject({ error: 'PAYMENT_RECEIPT_WRONG_RESOURCE' });
  });
});
