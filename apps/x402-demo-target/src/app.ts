import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { z } from 'zod';

import type { NativeTransferReader } from './native-payment-verifier.js';
import { createProviderSigner, signResponseBody } from './provider-signing.js';
import { DemoReceiptInvalidError, issueDemoReceipt, verifyDemoReceipt } from './receipt.js';

export type DemoTargetMode = 'V1_VULNERABLE' | 'V2_PROTECTED';

const PAID_RESOURCE_ROUTE = '/paid/resource';
const RECEIPT_HEADER = 'x-payment-receipt';
const PROVIDER_SIGNATURE_HEADER = 'x-provider-signature';
const transactionHashSchema = z.string().regex(/^0x[a-fA-F0-9]{64}$/);
const purchaseRequestSchema = z.object({ transactionHash: transactionHashSchema }).strict();

export interface RedemptionStore {
  /** Returns true the first time an orderId is seen, false on every replay. */
  tryRedeem(orderId: string): Promise<boolean>;
}

export class InMemoryRedemptionStore implements RedemptionStore {
  readonly #redeemedOrderIds = new Set<string>();

  async tryRedeem(orderId: string): Promise<boolean> {
    if (this.#redeemedOrderIds.has(orderId)) return false;
    this.#redeemedOrderIds.add(orderId);
    return true;
  }
}

export interface PurchaseLedger {
  /** Returns true the first time a payment transaction hash is claimed, false on reuse. */
  tryClaim(transactionHash: `0x${string}`): Promise<boolean>;
}

export class InMemoryPurchaseLedger implements PurchaseLedger {
  readonly #claimedTransactionHashes = new Set<string>();

  async tryClaim(transactionHash: `0x${string}`): Promise<boolean> {
    const key = transactionHash.toLowerCase();
    if (this.#claimedTransactionHashes.has(key)) return false;
    this.#claimedTransactionHashes.add(key);
    return true;
  }
}

export type PurchaseOptions = Readonly<{
  transferReader: NativeTransferReader;
  receivingAddress: `0x${string}`;
  minimumValueWei: bigint;
  minimumConfirmations: number;
  purchaseLedger?: PurchaseLedger;
  receiptValidForSeconds?: number;
}>;

export type DemoTargetOptions = Readonly<{
  mode: DemoTargetMode;
  receiptSecret: string;
  redemptionStore?: RedemptionStore;
  now?: () => Date;
  purchase?: PurchaseOptions;
  /** When set, every /paid/resource response carries an x-provider-signature header. */
  providerSignerPrivateKey?: `0x${string}`;
}>;

export function createDemoTargetApp(options: DemoTargetOptions): FastifyInstance {
  const redemptionStore = options.redemptionStore ?? new InMemoryRedemptionStore();
  const purchaseLedger = options.purchase?.purchaseLedger ?? new InMemoryPurchaseLedger();
  const now = options.now ?? (() => new Date());
  const providerSigner = options.providerSignerPrivateKey ? createProviderSigner(options.providerSignerPrivateKey) : undefined;
  const app = Fastify({ logger: { level: process.env['NODE_ENV'] === 'test' ? 'silent' : 'info' } });

  async function sendPaidResourceReply(reply: FastifyReply, statusCode: number, payload: unknown): Promise<void> {
    const bodyText = JSON.stringify(payload);
    if (providerSigner) {
      reply.header(PROVIDER_SIGNATURE_HEADER, await signResponseBody(providerSigner, bodyText));
    }
    await reply.status(statusCode).type('application/json').send(bodyText);
  }

  app.get('/health', async () => ({ status: 'ok', mode: options.mode }));

  app.post('/purchase', async (request, reply) => {
    const purchase = options.purchase;
    if (!purchase) return reply.status(503).send({ error: 'PURCHASE_NOT_CONFIGURED' });

    const parsedBody = purchaseRequestSchema.safeParse(request.body);
    if (!parsedBody.success) return reply.status(400).send({ error: 'INVALID_PURCHASE_REQUEST' });
    const { transactionHash } = parsedBody.data;

    const transfer = await purchase.transferReader.getConfirmedTransfer(transactionHash as `0x${string}`);
    if (!transfer) return reply.status(402).send({ error: 'PAYMENT_TRANSACTION_NOT_FOUND' });
    if (transfer.status !== 'success') return reply.status(402).send({ error: 'PAYMENT_TRANSACTION_REVERTED' });
    if (transfer.confirmations < BigInt(purchase.minimumConfirmations)) {
      return reply.status(402).send({ error: 'PAYMENT_NOT_YET_CONFIRMED' });
    }
    if (!transfer.to || transfer.to.toLowerCase() !== purchase.receivingAddress.toLowerCase()) {
      return reply.status(402).send({ error: 'PAYMENT_WRONG_RECIPIENT' });
    }
    if (transfer.valueWei < purchase.minimumValueWei) {
      return reply.status(402).send({ error: 'PAYMENT_INSUFFICIENT_AMOUNT' });
    }

    const firstClaim = await purchaseLedger.tryClaim(transactionHash as `0x${string}`);
    if (!firstClaim) return reply.status(409).send({ error: 'PAYMENT_TRANSACTION_ALREADY_CLAIMED' });

    const receipt = issueDemoReceipt(
      {
        orderId: transactionHash,
        atomicAmount: transfer.valueWei.toString(),
        resource: PAID_RESOURCE_ROUTE,
        validForSeconds: purchase.receiptValidForSeconds ?? 300,
      },
      options.receiptSecret,
      now(),
    );

    return reply.status(200).send({ receipt, resource: PAID_RESOURCE_ROUTE, atomicAmount: transfer.valueWei.toString() });
  });

  app.route({
    method: ['GET', 'POST'],
    url: PAID_RESOURCE_ROUTE,
    handler: async (request, reply) => {
      const header = request.headers[RECEIPT_HEADER];
      const token = Array.isArray(header) ? header[0] : header;
      if (!token) {
        return sendPaidResourceReply(reply, 402, { error: 'PAYMENT_RECEIPT_REQUIRED' });
      }

      let receipt;
      try {
        receipt = verifyDemoReceipt(token, options.receiptSecret, now());
      } catch (error) {
        if (error instanceof DemoReceiptInvalidError) {
          return sendPaidResourceReply(reply, 402, { error: 'INVALID_PAYMENT_RECEIPT', reason: error.message });
        }
        throw error;
      }

      if (receipt.resource !== PAID_RESOURCE_ROUTE) {
        return sendPaidResourceReply(reply, 402, { error: 'PAYMENT_RECEIPT_WRONG_RESOURCE' });
      }

      if (options.mode === 'V2_PROTECTED') {
        const firstRedemption = await redemptionStore.tryRedeem(receipt.orderId);
        if (!firstRedemption) {
          return sendPaidResourceReply(reply, 409, { error: 'PAYMENT_RECEIPT_ALREADY_REDEEMED' });
        }
      }

      return sendPaidResourceReply(reply, 200, {
        deliveryConfirmed: true,
        resource: receipt.resource,
        orderId: receipt.orderId,
        deliveredAt: now().toISOString(),
      });
    },
  });

  return app;
}

export { PAID_RESOURCE_ROUTE };
