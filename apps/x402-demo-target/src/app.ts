import Fastify, { type FastifyInstance } from 'fastify';

import { DemoReceiptInvalidError, verifyDemoReceipt } from './receipt.js';

export type DemoTargetMode = 'V1_VULNERABLE' | 'V2_PROTECTED';

const PAID_RESOURCE_ROUTE = '/paid/resource';
const RECEIPT_HEADER = 'x-payment-receipt';

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

export type DemoTargetOptions = Readonly<{
  mode: DemoTargetMode;
  receiptSecret: string;
  redemptionStore?: RedemptionStore;
  now?: () => Date;
}>;

export function createDemoTargetApp(options: DemoTargetOptions): FastifyInstance {
  const redemptionStore = options.redemptionStore ?? new InMemoryRedemptionStore();
  const now = options.now ?? (() => new Date());
  const app = Fastify({ logger: false });

  app.get('/health', async () => ({ status: 'ok', mode: options.mode }));

  app.route({
    method: ['GET', 'POST'],
    url: PAID_RESOURCE_ROUTE,
    handler: async (request, reply) => {
      const header = request.headers[RECEIPT_HEADER];
      const token = Array.isArray(header) ? header[0] : header;
      if (!token) {
        return reply.status(402).send({ error: 'PAYMENT_RECEIPT_REQUIRED' });
      }

      let receipt;
      try {
        receipt = verifyDemoReceipt(token, options.receiptSecret, now());
      } catch (error) {
        if (error instanceof DemoReceiptInvalidError) {
          return reply.status(402).send({ error: 'INVALID_PAYMENT_RECEIPT', reason: error.message });
        }
        throw error;
      }

      if (receipt.resource !== PAID_RESOURCE_ROUTE) {
        return reply.status(402).send({ error: 'PAYMENT_RECEIPT_WRONG_RESOURCE' });
      }

      if (options.mode === 'V2_PROTECTED') {
        const firstRedemption = await redemptionStore.tryRedeem(receipt.orderId);
        if (!firstRedemption) {
          return reply.status(409).send({ error: 'PAYMENT_RECEIPT_ALREADY_REDEEMED' });
        }
      }

      return reply.status(200).send({
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
