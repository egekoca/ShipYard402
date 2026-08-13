import type {
  BnbPaidRequestPort,
  BnbPermit2AllowancePort,
  BnbPurchaseRecord,
  BnbPurchaseStore,
  AuthorizedBnbX402Payment,
} from './ports.js';

export class BnbX402PaymentClient {
  readonly #maximumAtomicAmount: string;
  readonly #allowance: BnbPermit2AllowancePort;
  readonly #paidRequest: BnbPaidRequestPort;
  readonly #store: BnbPurchaseStore;

  constructor(
    input: Readonly<{
      /** The most this payer will ever settle in one purchase, whatever the target asks for. */
      maximumAtomicAmount: string;
      allowance: BnbPermit2AllowancePort;
      paidRequest: BnbPaidRequestPort;
      store: BnbPurchaseStore;
    }>,
  ) {
    assertPositiveAtomic(input.maximumAtomicAmount, 'maximumAtomicAmount');
    this.#maximumAtomicAmount = input.maximumAtomicAmount;
    this.#allowance = input.allowance;
    this.#paidRequest = input.paidRequest;
    this.#store = input.store;
  }

  async acquire(idempotencyKey: string, signal?: AbortSignal): Promise<AuthorizedBnbX402Payment> {
    if (idempotencyKey.trim().length === 0) throw new Error('idempotencyKey cannot be empty');
    const claimRecord: BnbPurchaseRecord = {
      status: 'CLAIMED',
      idempotencyKey,
      amountAtomic: this.#maximumAtomicAmount,
    };
    const claim = await this.#store.claim(claimRecord);
    if (!claim.acquired) {
      if (claim.record.status === 'AUTHORIZED' && claim.record.paymentReceipt && claim.record.paymentProofHash) {
        return {
          paymentReceipt: claim.record.paymentReceipt,
          paymentProofHash: claim.record.paymentProofHash,
          amountAtomic: claim.record.amountAtomic,
        };
      }
      throw new Error('BNB x402 payment with this idempotency key requires reconciliation');
    }

    try {
      throwIfAborted(signal);
      const quote = await this.#paidRequest.quote(signal);
      // Re-checked here even though the port's policy already bounded it: this class owns the
      // spend ceiling, and it must hold regardless of which port implementation produced the quote.
      if (BigInt(quote.amountAtomic) > BigInt(this.#maximumAtomicAmount)) {
        throw new Error('BNB x402 target price exceeds the configured maximum for this purchase');
      }
      throwIfAborted(signal);
      // EIP-3009 needs no allowance -- the signed authorization is itself the transfer permission.
      // Approving anyway would be an unnecessary on-chain write and a standing allowance we never use.
      if (quote.transferMethod === 'permit2') {
        await this.#allowance.ensureExactAllowance({ amountAtomic: quote.amountAtomic, asset: quote.asset }, signal);
      }
      throwIfAborted(signal);
      const payment = await this.#paidRequest.authorize(quote, signal);
      if (payment.amountAtomic !== quote.amountAtomic) {
        throw new Error('BNB x402 authorization amount differs from the quoted amount');
      }
      if (!payment.paymentReceipt) throw new Error('BNB x402 authorization receipt is empty');
      assertHash(payment.paymentProofHash, 'payment.paymentProofHash');
      await this.#store.markAuthorized(idempotencyKey, payment);
      return payment;
    } catch (error) {
      await this.#store.abandonClaim(idempotencyKey);
      throw error;
    }
  }
}

function assertPositiveAtomic(value: string, field: string): void {
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`${field} must be a positive atomic amount`);
}

function assertHash(value: string, field: string): asserts value is `0x${string}` {
  if (!/^0x[a-fA-F0-9]{64}$/.test(value)) throw new Error(`${field} must be a transaction hash`);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error('Operation aborted');
}
