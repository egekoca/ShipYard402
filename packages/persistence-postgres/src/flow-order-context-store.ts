import { flowRuntimeCapabilitySchema } from '@shipyard402/goat-network-config';
import type { FlowOrderContext, FlowOrderContextStore } from '@shipyard402/goat-flow-adapter';
import type { MerchantOrder, X402PaymentRequiredChallenge } from '@shipyard402/x402-payments';
import type { Pool, QueryResultRow } from 'pg';
import { z } from 'zod';

const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const challengeSchema = z.object({
  x402Version: z.number().int().nonnegative(),
  resource: z.object({
    url: z.string().url(),
    description: z.string().optional(),
    mimeType: z.string().optional(),
  }).passthrough(),
  accepts: z.array(z.object({
    scheme: z.string().min(1),
    network: z.string().min(1),
    amount: z.string().regex(/^(0|[1-9]\d*)$/),
    asset: addressSchema,
    payTo: addressSchema,
    maxTimeoutSeconds: z.number().int().nonnegative(),
    extra: z.record(z.unknown()).optional(),
  }).passthrough()).min(1),
  extensions: z.record(z.unknown()).optional(),
}).passthrough();

const orderSchema = z.object({
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
}).strict();

type ContextRow = QueryResultRow & {
  order_snapshot: unknown;
  capability_snapshot: unknown;
};

export class PostgresFlowOrderContextStore implements FlowOrderContextStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async put(context: FlowOrderContext): Promise<void> {
    await this.#pool.query(
      `INSERT INTO payment_orders (
        run_id, order_id, dapp_order_id, status, chain_id, token, payer, recipient,
        atomic_amount, expires_at, order_snapshot, capability_snapshot
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb)
      ON CONFLICT (dapp_order_id) DO NOTHING`,
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
        JSON.stringify(context.order),
        JSON.stringify(context.capability),
      ],
    );
    const persisted = await this.getByDappOrderId(context.order.dappOrderId);
    if (!persisted || canonicalJson(persisted) !== canonicalJson(context)) {
      throw new Error('Persisted GOAT Flow order context conflicts with the requested DApp order');
    }
  }

  async get(orderId: string): Promise<FlowOrderContext | null> {
    const result = await this.#pool.query<ContextRow>(
      `SELECT order_snapshot, capability_snapshot FROM payment_orders WHERE order_id = $1`,
      [orderId],
    );
    return result.rows[0] ? parseContext(result.rows[0]) : null;
  }

  async getByDappOrderId(dappOrderId: string): Promise<FlowOrderContext | null> {
    const result = await this.#pool.query<ContextRow>(
      `SELECT order_snapshot, capability_snapshot FROM payment_orders WHERE dapp_order_id = $1`,
      [dappOrderId],
    );
    return result.rows[0] ? parseContext(result.rows[0]) : null;
  }
}

function parseContext(row: ContextRow): FlowOrderContext {
  const parsedOrder = orderSchema.parse(row.order_snapshot);
  return {
    order: {
      ...parsedOrder,
      tokenAddress: parsedOrder.tokenAddress as `0x${string}`,
      payerAddress: parsedOrder.payerAddress as `0x${string}`,
      payToAddress: parsedOrder.payToAddress as `0x${string}`,
      paymentRequired: parsedOrder.paymentRequired as X402PaymentRequiredChallenge,
    } satisfies MerchantOrder,
    capability: flowRuntimeCapabilitySchema.parse(row.capability_snapshot),
  };
}

function hexToBuffer(value: string): Buffer {
  return Buffer.from(value.slice(2), 'hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}
