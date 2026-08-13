import type { PaymentRequirements } from '@x402/core/types';

import type { AssetTransferMethod } from './requirement-policy.js';

export type AuthorizedBnbX402Payment = Readonly<{
  paymentReceipt: string;
  paymentProofHash: `0x${string}`;
  amountAtomic: string;
}>;

export interface BnbPermit2AllowancePort {
  /** Grants Permit2 exactly `amountAtomic` of `asset` -- never an unbounded approval. */
  ensureExactAllowance(
    input: Readonly<{ amountAtomic: string; asset: `0x${string}` }>,
    signal?: AbortSignal,
  ): Promise<void>;
}

/** The terms a target published and this payer accepted, before anything is signed. */
export type BnbPaymentQuote = Readonly<{
  amountAtomic: string;
  asset: `0x${string}`;
  payTo: `0x${string}`;
  transferMethod: AssetTransferMethod;
  requirement: PaymentRequirements;
  /** The full 402 body the payload must be built against, carried so authorize() need not refetch. */
  paymentRequired: unknown;
}>;

/**
 * Split in two on purpose. A target's price, asset and transfer method are only knowable from its
 * own 402 response, and the allowance we must grant depends on all three -- so reading the terms
 * has to happen strictly before, and separately from, signing anything against them.
 */
export interface BnbPaidRequestPort {
  quote(signal?: AbortSignal): Promise<BnbPaymentQuote>;
  authorize(quote: BnbPaymentQuote, signal?: AbortSignal): Promise<AuthorizedBnbX402Payment>;
}

export type BnbPurchaseRecord = Readonly<{
  status: 'CLAIMED' | 'AUTHORIZED';
  idempotencyKey: string;
  /**
   * While CLAIMED this is the ceiling the key reserved; once AUTHORIZED it is the price actually
   * settled, which is only knowable after the target's challenge is read. Replaying an authorized
   * key therefore reports the same amount the original call did.
   */
  amountAtomic: string;
  paymentReceipt?: string;
  paymentProofHash?: `0x${string}`;
}>;

export interface BnbPurchaseStore {
  claim(record: BnbPurchaseRecord): Promise<Readonly<{ acquired: boolean; record: BnbPurchaseRecord }>>;
  markAuthorized(idempotencyKey: string, payment: AuthorizedBnbX402Payment): Promise<BnbPurchaseRecord>;
  abandonClaim(idempotencyKey: string): Promise<void>;
}

export class InMemoryBnbPurchaseStore implements BnbPurchaseStore {
  readonly #records = new Map<string, BnbPurchaseRecord>();

  async claim(record: BnbPurchaseRecord): Promise<Readonly<{ acquired: boolean; record: BnbPurchaseRecord }>> {
    const existing = this.#records.get(record.idempotencyKey);
    if (existing) return { acquired: false, record: existing };
    this.#records.set(record.idempotencyKey, record);
    return { acquired: true, record };
  }

  async markAuthorized(idempotencyKey: string, payment: AuthorizedBnbX402Payment): Promise<BnbPurchaseRecord> {
    const existing = this.#records.get(idempotencyKey);
    if (!existing) throw new Error('BNB x402 purchase claim does not exist');
    const authorized: BnbPurchaseRecord = {
      ...existing,
      status: 'AUTHORIZED',
      amountAtomic: payment.amountAtomic,
      paymentReceipt: payment.paymentReceipt,
      paymentProofHash: payment.paymentProofHash,
    };
    this.#records.set(idempotencyKey, authorized);
    return authorized;
  }

  async abandonClaim(idempotencyKey: string): Promise<void> {
    const record = this.#records.get(idempotencyKey);
    if (record?.status === 'CLAIMED') this.#records.delete(idempotencyKey);
  }
}
