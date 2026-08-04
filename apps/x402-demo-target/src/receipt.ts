import { createHmac, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

/**
 * This is a synthetic, HMAC-signed stand-in for a settled x402 payment proof.
 * It exists only so the two demo target modes below can deterministically
 * demonstrate the payment-proof replay vulnerability class without depending
 * on a real GOAT Flow merchant account. It must never be treated as, or
 * confused with, a `MerchantPaymentProof` from `@shipyard402/x402-payments`.
 */
const receiptPayloadSchema = z.object({
  orderId: z.string().min(1).max(200),
  atomicAmount: z.string().regex(/^(0|[1-9]\d*)$/),
  resource: z.string().min(1).max(500),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strict();

export type DemoPaymentReceipt = z.infer<typeof receiptPayloadSchema>;

export class DemoReceiptInvalidError extends Error {
  constructor(reason: string) {
    super(`Demo payment receipt is invalid: ${reason}`);
    this.name = 'DemoReceiptInvalidError';
  }
}

export function issueDemoReceipt(
  input: Readonly<{ orderId: string; atomicAmount: string; resource: string; validForSeconds: number }>,
  secret: string,
  now: Date = new Date(),
): string {
  const payload: DemoPaymentReceipt = {
    orderId: input.orderId,
    atomicAmount: input.atomicAmount,
    resource: input.resource,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + input.validForSeconds * 1_000).toISOString(),
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = sign(encodedPayload, secret);
  return `${encodedPayload}.${signature}`;
}

export function verifyDemoReceipt(token: string, secret: string, now: Date = new Date()): DemoPaymentReceipt {
  const separatorIndex = token.indexOf('.');
  if (separatorIndex < 0) throw new DemoReceiptInvalidError('malformed token');
  const encodedPayload = token.slice(0, separatorIndex);
  const signature = token.slice(separatorIndex + 1);

  const expectedSignature = sign(encodedPayload, secret);
  if (!constantTimeEquals(signature, expectedSignature)) {
    throw new DemoReceiptInvalidError('signature mismatch');
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    throw new DemoReceiptInvalidError('malformed payload');
  }
  const parsed = receiptPayloadSchema.safeParse(decoded);
  if (!parsed.success) throw new DemoReceiptInvalidError('payload does not match the receipt schema');

  if (Date.parse(parsed.data.expiresAt) <= now.getTime()) {
    throw new DemoReceiptInvalidError('receipt has expired');
  }
  return parsed.data;
}

function sign(encodedPayload: string, secret: string): string {
  return createHmac('sha256', secret).update(encodedPayload).digest('base64url');
}

function constantTimeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}
