import { verifyResponseSignature } from '@shipyard402/protected-delivery-runner';
import { createHash } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it } from 'vitest';

import { createDemoTargetApp, PAID_RESOURCE_ROUTE } from './app.js';
import type { ConfirmedNativeTransfer, NativeTransferReader } from './native-payment-verifier.js';
import { purchaseClaimMessage } from './purchase-claim.js';
import { issueDemoReceipt, verifyDemoReceipt } from './receipt.js';

const SECRET = 'a'.repeat(32);
const NOW = new Date('2026-08-05T00:00:00.000Z');
const RECEIVING_ADDRESS = '0x3000000000000000000000000000000000000003' as const;
const TX_HASH = `0x${'bb'.repeat(32)}` as const;
// A syntactically valid (but never-recovering) signature, for tests whose rejection happens
// before signature verification is ever reached.
const DUMMY_SIGNATURE = `0x${'11'.repeat(65)}` as const;

const PAYER_KEY = `0x${'22'.repeat(32)}` as const;
const PAYER_ADDRESS = privateKeyToAccount(PAYER_KEY).address;

async function signPurchaseClaim(transactionHash: string, key: `0x${string}` = PAYER_KEY): Promise<`0x${string}`> {
  return privateKeyToAccount(key).signMessage({ message: purchaseClaimMessage(transactionHash) });
}

function fakeTransferReader(transfer: ConfirmedNativeTransfer | null): NativeTransferReader {
  return { getConfirmedTransfer: async () => transfer };
}

function confirmedTransfer(overrides: Partial<ConfirmedNativeTransfer> = {}): ConfirmedNativeTransfer {
  return {
    transactionHash: TX_HASH,
    status: 'success',
    from: PAYER_ADDRESS,
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

      const response = await app.inject({
        method: 'POST', url: '/purchase',
        payload: { transactionHash: TX_HASH, signature: await signPurchaseClaim(TX_HASH) },
      });
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
      const response = await app.inject({
        method: 'POST', url: '/purchase',
        payload: { transactionHash: TX_HASH, signature: DUMMY_SIGNATURE },
      });
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
      const response = await app.inject({
        method: 'POST', url: '/purchase',
        payload: { transactionHash: TX_HASH, signature: DUMMY_SIGNATURE },
      });
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
      const response = await app.inject({
        method: 'POST', url: '/purchase',
        payload: { transactionHash: TX_HASH, signature: DUMMY_SIGNATURE },
      });
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
      const response = await app.inject({
        method: 'POST', url: '/purchase',
        payload: { transactionHash: TX_HASH, signature: DUMMY_SIGNATURE },
      });
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
      const response = await app.inject({
        method: 'POST', url: '/purchase',
        payload: { transactionHash: TX_HASH, signature: DUMMY_SIGNATURE },
      });
      expect(response.json()).toMatchObject({ error: 'PAYMENT_INSUFFICIENT_AMOUNT' });
    });

    it('rejects a claim whose signature does not recover to the transaction sender', async () => {
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
      // An observer who read the (public) transaction hash off-chain but does not hold the
      // payer's private key cannot produce a signature that recovers to transfer.from.
      const impostorKey = `0x${'99'.repeat(32)}` as const;
      const response = await app.inject({
        method: 'POST', url: '/purchase',
        payload: { transactionHash: TX_HASH, signature: await signPurchaseClaim(TX_HASH, impostorKey) },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: 'PURCHASE_SIGNATURE_DOES_NOT_MATCH_PAYER' });
    });

    it('rejects a malformed signature without ever reaching the ledger', async () => {
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
      const response = await app.inject({
        method: 'POST', url: '/purchase',
        payload: { transactionHash: TX_HASH, signature: `0x${'ab'.repeat(65)}` },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: 'PURCHASE_SIGNATURE_INVALID' });
    });

    it('re-issues a fresh receipt when the same verified payer retries a claim, instead of erroring', async () => {
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
      const signature = await signPurchaseClaim(TX_HASH);
      const first = await app.inject({ method: 'POST', url: '/purchase', payload: { transactionHash: TX_HASH, signature } });
      expect(first.statusCode).toBe(200);
      // This is exactly what an orchestrator retry after a checkpoint-write failure looks like:
      // the same signer re-submitting the same already-earned transaction hash.
      const second = await app.inject({ method: 'POST', url: '/purchase', payload: { transactionHash: TX_HASH, signature } });
      expect(second.statusCode).toBe(200);
      const { receipt } = second.json() as { receipt: string };
      expect(verifyDemoReceipt(receipt, SECRET, NOW)).toMatchObject({ orderId: TX_HASH });
    });

    it('an observer racing the real payer to claim their receipt cannot, even after the real payer has already claimed it', async () => {
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
      const first = await app.inject({
        method: 'POST', url: '/purchase',
        payload: { transactionHash: TX_HASH, signature: await signPurchaseClaim(TX_HASH) },
      });
      expect(first.statusCode).toBe(200);
      const impostorKey = `0x${'44'.repeat(32)}` as const;
      const second = await app.inject({
        method: 'POST', url: '/purchase',
        payload: { transactionHash: TX_HASH, signature: await signPurchaseClaim(TX_HASH, impostorKey) },
      });
      expect(second.statusCode).toBe(401);
      expect(second.json()).toMatchObject({ error: 'PURCHASE_SIGNATURE_DOES_NOT_MATCH_PAYER' });
    });
  });
});
