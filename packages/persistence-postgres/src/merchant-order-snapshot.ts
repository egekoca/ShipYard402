import type { MerchantOrder, X402PaymentRequiredChallenge } from '@shipyard402/x402-payments';
import { z } from 'zod';

const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);

export const x402ChallengeSchema = z
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

export const merchantOrderSchema = z
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
    paymentRequired: x402ChallengeSchema,
  })
  .strict();

/**
 * `payment_orders.order_snapshot` is written by whichever merchant adapter created the order, and
 * the two adapters disagree on shape: GOAT Flow stores the order at the top level, while the BOT
 * Chain direct adapter wraps it as `{ order, submittedTransactionHash?, proof? }` because it also
 * has to remember the transaction it was handed. Anything that only needs the order itself — the
 * run repository, for one — must accept both, otherwise loading a run created by the other adapter
 * throws instead of returning the run.
 */
export function parseMerchantOrderSnapshot(snapshot: unknown): MerchantOrder {
  const wrapped =
    typeof snapshot === 'object' && snapshot !== null && 'order' in snapshot
      ? (snapshot as { order: unknown }).order
      : snapshot;
  const parsed = merchantOrderSchema.parse(wrapped);
  return {
    ...parsed,
    tokenAddress: parsed.tokenAddress as `0x${string}`,
    payerAddress: parsed.payerAddress as `0x${string}`,
    payToAddress: parsed.payToAddress as `0x${string}`,
    paymentRequired: parsed.paymentRequired as X402PaymentRequiredChallenge,
  } satisfies MerchantOrder;
}
