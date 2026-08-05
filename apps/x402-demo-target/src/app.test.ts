import { verifyResponseSignature } from '@shipyard402/protected-delivery-runner';
import { createHash } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it } from 'vitest';

import { createDemoTargetApp, PAID_RESOURCE_ROUTE } from './app.js';
import type { ConfirmedNativeTransfer, NativeTransferReader } from './native-payment-verifier.js';
import { issueDemoReceipt, verifyDemoReceipt } from './receipt.js';

const SECRET = 'a'.repeat(32);
const NOW = new Date('2026-08-05T00:00:00.000Z');
const RECEIVING_ADDRESS = '0x3000000000000000000000000000000000000003' as const;
const TX_HASH = `0x${'bb'.repeat(32)}` as const;

function fakeTransferReader(transfer: ConfirmedNativeTransfer | null): NativeTransferReader {
  return { getConfirmedTransfer: async () => transfer };
}

function confirmedTransfer(overrides: Partial<ConfirmedNativeTransfer> = {}): ConfirmedNativeTransfer {
  return {
    transactionHash: TX_HASH,
    status: 'success',
    from: '0x2000000000000000000000000000000000000002',
    to: RECEIVING_ADDRESS,
    valueWei: 1_000_000_000_000n,
    confirmations: 3n,
    ...overrides,
  };
}

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

  describe('provider response signing', () => {
    const providerKey = `0x${'33'.repeat(32)}` as const;
    const providerAddress = privateKeyToAccount(providerKey).address;

    it('carries no signature header when no provider signer is configured', async () => {
      app = createDemoTargetApp({ mode: 'V1_VULNERABLE', receiptSecret: SECRET, now: () => NOW });
      const response = await app.inject({ method: 'GET', url: PAID_RESOURCE_ROUTE });
      expect(response.headers['x-provider-signature']).toBeUndefined();
    });

    it('signs a successful delivery response with the configured provider key', async () => {
      app = createDemoTargetApp({ mode: 'V1_VULNERABLE', receiptSecret: SECRET, now: () => NOW, providerSignerPrivateKey: providerKey });
      const token = issueDemoReceipt(
        { orderId: 'signed-order', atomicAmount: '1000', resource: PAID_RESOURCE_ROUTE, validForSeconds: 60 },
        SECRET,
        NOW,
      );
      const response = await app.inject({ method: 'GET', url: PAID_RESOURCE_ROUTE, headers: { 'x-payment-receipt': token } });
      expect(response.statusCode).toBe(200);
      const signature = response.headers['x-provider-signature'] as `0x${string}`;
      expect(signature).toBeDefined();

      const bodyHash = `0x${createHash('sha256').update(response.rawPayload).digest('hex')}` as `0x${string}`;
      expect(verifyResponseSignature(bodyHash, signature, providerAddress as `0x${string}`)).toBe(true);
    });

    it('signs a rejection response too, not only successful deliveries', async () => {
      app = createDemoTargetApp({ mode: 'V1_VULNERABLE', receiptSecret: SECRET, now: () => NOW, providerSignerPrivateKey: providerKey });
      const response = await app.inject({ method: 'GET', url: PAID_RESOURCE_ROUTE });
      expect(response.statusCode).toBe(402);
      const signature = response.headers['x-provider-signature'] as `0x${string}`;
      const bodyHash = `0x${createHash('sha256').update(response.rawPayload).digest('hex')}` as `0x${string}`;
      expect(verifyResponseSignature(bodyHash, signature, providerAddress as `0x${string}`)).toBe(true);
    });

    it('does not verify against a signer address other than the one actually configured', async () => {
      app = createDemoTargetApp({ mode: 'V1_VULNERABLE', receiptSecret: SECRET, now: () => NOW, providerSignerPrivateKey: providerKey });
      const response = await app.inject({ method: 'GET', url: PAID_RESOURCE_ROUTE });
      const signature = response.headers['x-provider-signature'] as `0x${string}`;
      const bodyHash = `0x${createHash('sha256').update(response.rawPayload).digest('hex')}` as `0x${string}`;
      const someoneElse = '0x9999999999999999999999999999999999999a' as const;
      expect(verifyResponseSignature(bodyHash, signature, someoneElse)).toBe(false);
    });
  });

  describe('POST /purchase', () => {
    it('returns 503 when purchase is not configured', async () => {
      app = createDemoTargetApp({ mode: 'V2_PROTECTED', receiptSecret: SECRET, now: () => NOW });
      const response = await app.inject({ method: 'POST', url: '/purchase', payload: { transactionHash: TX_HASH } });
      expect(response.statusCode).toBe(503);
    });

    it('issues a spendable receipt for a confirmed, correctly addressed, sufficiently funded transfer', async () => {
      app = createDemoTargetApp({
        mode: 'V2_PROTECTED',
        receiptSecret: SECRET,
        now: () => NOW,
        purchase: {
          transferReader: fakeTransferReader(confirmedTransfer()),
          receivingAddress: RECEIVING_ADDRESS,
          minimumValueWei: 1_000_000_000_000n,
          minimumConfirmations: 1,
        },
      });

      const response = await app.inject({ method: 'POST', url: '/purchase', payload: { transactionHash: TX_HASH } });
      expect(response.statusCode).toBe(200);
      const { receipt } = response.json() as { receipt: string };
      expect(verifyDemoReceipt(receipt, SECRET, NOW)).toMatchObject({ orderId: TX_HASH, resource: PAID_RESOURCE_ROUTE });
    });

    it('rejects a transaction that cannot be found on-chain', async () => {
      app = createDemoTargetApp({
        mode: 'V2_PROTECTED',
        receiptSecret: SECRET,
        now: () => NOW,
        purchase: {
          transferReader: fakeTransferReader(null),
          receivingAddress: RECEIVING_ADDRESS,
          minimumValueWei: 1n,
          minimumConfirmations: 1,
        },
      });
      const response = await app.inject({ method: 'POST', url: '/purchase', payload: { transactionHash: TX_HASH } });
      expect(response.statusCode).toBe(402);
      expect(response.json()).toMatchObject({ error: 'PAYMENT_TRANSACTION_NOT_FOUND' });
    });

    it('rejects a reverted transaction', async () => {
      app = createDemoTargetApp({
        mode: 'V2_PROTECTED',
        receiptSecret: SECRET,
        now: () => NOW,
        purchase: {
          transferReader: fakeTransferReader(confirmedTransfer({ status: 'reverted' })),
          receivingAddress: RECEIVING_ADDRESS,
          minimumValueWei: 1n,
          minimumConfirmations: 1,
        },
      });
      const response = await app.inject({ method: 'POST', url: '/purchase', payload: { transactionHash: TX_HASH } });
      expect(response.json()).toMatchObject({ error: 'PAYMENT_TRANSACTION_REVERTED' });
    });

    it('rejects an underconfirmed transaction', async () => {
      app = createDemoTargetApp({
        mode: 'V2_PROTECTED',
        receiptSecret: SECRET,
        now: () => NOW,
        purchase: {
          transferReader: fakeTransferReader(confirmedTransfer({ confirmations: 0n })),
          receivingAddress: RECEIVING_ADDRESS,
          minimumValueWei: 1n,
          minimumConfirmations: 2,
        },
      });
      const response = await app.inject({ method: 'POST', url: '/purchase', payload: { transactionHash: TX_HASH } });
      expect(response.json()).toMatchObject({ error: 'PAYMENT_NOT_YET_CONFIRMED' });
    });

    it('rejects a transfer paid to the wrong address', async () => {
      app = createDemoTargetApp({
        mode: 'V2_PROTECTED',
        receiptSecret: SECRET,
        now: () => NOW,
        purchase: {
          transferReader: fakeTransferReader(confirmedTransfer({ to: '0x9999999999999999999999999999999999999a' })),
          receivingAddress: RECEIVING_ADDRESS,
          minimumValueWei: 1n,
          minimumConfirmations: 1,
        },
      });
      const response = await app.inject({ method: 'POST', url: '/purchase', payload: { transactionHash: TX_HASH } });
      expect(response.json()).toMatchObject({ error: 'PAYMENT_WRONG_RECIPIENT' });
    });

    it('rejects an underpaid transfer', async () => {
      app = createDemoTargetApp({
        mode: 'V2_PROTECTED',
        receiptSecret: SECRET,
        now: () => NOW,
        purchase: {
          transferReader: fakeTransferReader(confirmedTransfer({ valueWei: 1n })),
          receivingAddress: RECEIVING_ADDRESS,
          minimumValueWei: 1_000_000_000_000n,
          minimumConfirmations: 1,
        },
      });
      const response = await app.inject({ method: 'POST', url: '/purchase', payload: { transactionHash: TX_HASH } });
      expect(response.json()).toMatchObject({ error: 'PAYMENT_INSUFFICIENT_AMOUNT' });
    });

    it('rejects reusing the same payment transaction for a second receipt', async () => {
      app = createDemoTargetApp({
        mode: 'V2_PROTECTED',
        receiptSecret: SECRET,
        now: () => NOW,
        purchase: {
          transferReader: fakeTransferReader(confirmedTransfer()),
          receivingAddress: RECEIVING_ADDRESS,
          minimumValueWei: 1n,
          minimumConfirmations: 1,
        },
      });
      const first = await app.inject({ method: 'POST', url: '/purchase', payload: { transactionHash: TX_HASH } });
      expect(first.statusCode).toBe(200);
      const second = await app.inject({ method: 'POST', url: '/purchase', payload: { transactionHash: TX_HASH } });
      expect(second.statusCode).toBe(409);
      expect(second.json()).toMatchObject({ error: 'PAYMENT_TRANSACTION_ALREADY_CLAIMED' });
    });
  });
});
