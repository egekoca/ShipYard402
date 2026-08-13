import { describe, expect, it } from 'vitest';

import { BNB_CANONICAL_USDT } from './constants.js';
import { BnbX402PaymentClient } from './payment-client.js';
import {
  InMemoryBnbPurchaseStore,
  type BnbPaidRequestPort,
  type BnbPaymentQuote,
  type BnbPermit2AllowancePort,
} from './ports.js';

const PROOF_HASH = `0x${'1'.repeat(64)}` as const;
const CEILING = '100000000000000';

class FakeAllowance implements BnbPermit2AllowancePort {
  calls: { amountAtomic: string; asset: string }[] = [];
  async ensureExactAllowance(input: { amountAtomic: string; asset: `0x${string}` }) {
    this.calls.push(input);
  }
}

class FakePaidRequest implements BnbPaidRequestPort {
  quotes = 0;
  authorizations = 0;
  amountAtomic = '60000000000000';
  transferMethod: BnbPaymentQuote['transferMethod'] = 'permit2';
  /** Lets a test simulate a port that signs for something other than what it quoted. */
  authorizedAmountAtomic?: string;

  async quote(): Promise<BnbPaymentQuote> {
    this.quotes += 1;
    return {
      amountAtomic: this.amountAtomic,
      asset: BNB_CANONICAL_USDT,
      payTo: '0x4000000000000000000000000000000000000004',
      transferMethod: this.transferMethod,
      requirement: {} as BnbPaymentQuote['requirement'],
      paymentRequired: {},
    };
  }

  async authorize(quote: BnbPaymentQuote) {
    this.authorizations += 1;
    return {
      paymentReceipt: 'signed-x402-v2-payment',
      paymentProofHash: PROOF_HASH,
      amountAtomic: this.authorizedAmountAtomic ?? quote.amountAtomic,
    };
  }
}

function harness() {
  const allowance = new FakeAllowance();
  const paidRequest = new FakePaidRequest();
  const client = new BnbX402PaymentClient({
    maximumAtomicAmount: CEILING,
    allowance,
    paidRequest,
    store: new InMemoryBnbPurchaseStore(),
  });
  return { client, allowance, paidRequest };
}

describe('BnbX402PaymentClient', () => {
  it('pays the price the target quoted, not a preconfigured amount', async () => {
    const { client, paidRequest } = harness();

    await expect(client.acquire('run-1:target-payment')).resolves.toMatchObject({
      paymentProofHash: PROOF_HASH,
      amountAtomic: '60000000000000',
    });
    expect(paidRequest.quotes).toBe(1);
  });

  it('approves exactly the quoted amount of the quoted asset, never more', async () => {
    const { client, allowance } = harness();

    await client.acquire('run-1:target-payment');

    expect(allowance.calls).toEqual([{ amountAtomic: '60000000000000', asset: BNB_CANONICAL_USDT }]);
  });

  it('skips the approval entirely for EIP-3009, where the signature is the permission', async () => {
    const { client, allowance, paidRequest } = harness();
    paidRequest.transferMethod = 'eip3009';

    await client.acquire('run-1:target-payment');

    expect(allowance.calls).toEqual([]);
  });

  it('refuses a quote above its own ceiling before approving anything', async () => {
    const { client, allowance, paidRequest } = harness();
    paidRequest.amountAtomic = '100000000000001';

    await expect(client.acquire('run-1:target-payment')).rejects.toThrow(/exceeds the configured maximum/);
    expect(allowance.calls).toEqual([]);
    expect(paidRequest.authorizations).toBe(0);
  });

  it('refuses a signature whose amount drifted from the quote it was given', async () => {
    const { client, paidRequest } = harness();
    paidRequest.authorizedAmountAtomic = '70000000000000';

    await expect(client.acquire('run-1:target-payment')).rejects.toThrow(/differs from the quoted amount/);
  });

  it('does not create a second payment for the same idempotency key', async () => {
    const { client, paidRequest } = harness();

    const first = await client.acquire('run-1:target-payment');
    const second = await client.acquire('run-1:target-payment');

    expect(second).toEqual(first);
    expect(paidRequest.authorizations).toBe(1);
  });

  it('releases the claim when the purchase fails, so a retry is not permanently blocked', async () => {
    const { client, paidRequest } = harness();
    paidRequest.amountAtomic = '100000000000001';
    await expect(client.acquire('run-1:target-payment')).rejects.toThrow();

    paidRequest.amountAtomic = '50';
    await expect(client.acquire('run-1:target-payment')).resolves.toMatchObject({ amountAtomic: '50' });
  });
});
