import type { BotChainRuntimeCapability } from '@shipyard402/bot-chain-network-config';
import { botChainRuntimeCapabilitySchema } from '@shipyard402/bot-chain-network-config';
import type { BotChainOrderContext, BotChainOrderContextStore } from '@shipyard402/bot-chain-adapter';
import type { MerchantOrder, MerchantPaymentProof, X402PaymentRequiredChallenge } from '@shipyard402/x402-payments';
import type { Pool, QueryResultRow } from 'pg';
import { z } from 'zod';

const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const hashSchema = z.string().regex(/^0x[a-fA-F0-9]{64}$/);
const challengeSchema = z
  .object({
    x402Version: z.number().int().nonnegative(),
    resource: z
      .object({ url: z.string().url(), description: z.string().optional(), mimeType: z.string().optional() })
      .passthrough(),
    accepts: z
      .array(
        z
          .object({
            scheme: z.string().min(1),
            network: z.string().min(1),
            amount: z.string().regex(/^(0|[1-9]\d*)$/),
            asset: addressSchema,
            payTo: addressSchema,
            maxTimeoutSeconds: z.number().int().nonnegative(),
            extra: z.record(z.unknown()).optional(),
          })
          .passthrough(),
      )
      .min(1),
    extensions: z.record(z.unknown()).optional(),
  })
  .passthrough();

const orderSchema = z
  .object({
    orderId: z.string().min(1),
    dappOrderId: z.string().min(1),
    status: z.enum(['CHECKOUT_VERIFIED', 'PAYMENT_CONFIRMED', 'INVOICED', 'FAILED', 'EXPIRED', 'CANCELLED']),
    chainId: z.number().int().positive(),
    tokenAddress: addressSchema,
    atomicAmount: z.string().regex(/^(0|[1-9]\d*)$/),
    payerAddress: addressSchema,
    payToAddress: addressSchema,
    expiresAt: z.string().datetime(),
    paymentRequired: challengeSchema,
  })
  .strict();

const proofSchema = z
  .object({
    orderId: z.string().min(1),
    transactionHash: hashSchema,
    logIndex: z.number().int().nonnegative(),
    fromAddress: addressSchema,
    toAddress: addressSchema,
    atomicAmount: z.string().regex(/^(0|[1-9]\d*)$/),
    chainId: z.number().int().positive(),
    providerDigest: hashSchema.optional(),
  })
  .strict();

// What's actually stored in payment_orders.order_snapshot for a BOT Chain row -- the same table
// GOAT's PostgresFlowOrderContextStore writes to (it has no chain-specific columns), just with a
// richer snapshot: BOT Chain has no remote order-tracking API, so the submitted transaction hash
// and the resulting settlement proof have to live here locally instead of being fetched from GOAT
// Flow on demand.
const snapshotSchema = z
  .object({
    order: orderSchema,
    submittedTransactionHash: hashSchema.optional(),
    proof: proofSchema.optional(),
  })
  .strict();

type ContextRow = QueryResultRow & {
  order_snapshot: unknown;
  capability_snapshot: unknown;
};

export class PostgresBotChainOrderContextStore implements BotChainOrderContextStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async put(context: BotChainOrderContext): Promise<void> {
    const snapshot = {
      order: context.order,
      ...(context.submittedTransactionHash ? { submittedTransactionHash: context.submittedTransactionHash } : {}),
      ...(context.proof ? { proof: context.proof } : {}),
    };
    await this.#pool.query(
      `INSERT INTO payment_orders (
        run_id, order_id, dapp_order_id, status, chain_id, token, payer, recipient,
        atomic_amount, expires_at, order_snapshot, capability_snapshot
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb)
      ON CONFLICT (dapp_order_id) DO UPDATE SET
        status = EXCLUDED.status,
        order_snapshot = EXCLUDED.order_snapshot,
        updated_at = now()`,
      [
        context.order.dappOrderId,
        context.order.orderId,
        context.order.dappOrderId,
        context.order.status,
        context.order.chainId,
        hexToBuffer(context.order.tokenAddress),
        hexToBuffer(context.order.payerAddress),
        hexToBuffer(context.order.payToAddress),
        context.order.atomicAmount,
        context.order.expiresAt,
        JSON.stringify(snapshot),
        JSON.stringify(context.capability),
      ],
    );
  }

  async get(orderId: string): Promise<BotChainOrderContext | null> {
    const result = await this.#pool.query<ContextRow>(
      `SELECT order_snapshot, capability_snapshot FROM payment_orders WHERE order_id = $1`,
      [orderId],
    );
    return result.rows[0] ? parseContext(result.rows[0]) : null;
  }

  async getByDappOrderId(dappOrderId: string): Promise<BotChainOrderContext | null> {
    const result = await this.#pool.query<ContextRow>(
      `SELECT order_snapshot, capability_snapshot FROM payment_orders WHERE dapp_order_id = $1`,
      [dappOrderId],
    );
    return result.rows[0] ? parseContext(result.rows[0]) : null;
  }
}

function parseContext(row: ContextRow): BotChainOrderContext {
  const parsedSnapshot = snapshotSchema.parse(row.order_snapshot);
  const order: MerchantOrder = {
    ...parsedSnapshot.order,
    tokenAddress: parsedSnapshot.order.tokenAddress as `0x${string}`,
    payerAddress: parsedSnapshot.order.payerAddress as `0x${string}`,
    payToAddress: parsedSnapshot.order.payToAddress as `0x${string}`,
    paymentRequired: parsedSnapshot.order.paymentRequired as X402PaymentRequiredChallenge,
  };
  const capability: BotChainRuntimeCapability = botChainRuntimeCapabilitySchema.parse(row.capability_snapshot);
  return {
    order,
    capability,
    ...(parsedSnapshot.submittedTransactionHash
      ? { submittedTransactionHash: parsedSnapshot.submittedTransactionHash as `0x${string}` }
      : {}),
    ...(parsedSnapshot.proof ? { proof: parsedSnapshot.proof as MerchantPaymentProof } : {}),
  };
}

function hexToBuffer(value: string): Buffer {
  return Buffer.from(value.slice(2), 'hex');
}
