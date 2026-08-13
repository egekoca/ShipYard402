import { describe, expect, it } from 'vitest';

import {
  BNB_CHAIN_MAINNET_NETWORK,
  GOAT_MAINNET_NETWORK,
  assertBridgeQuotePayable,
  createCrossChainProcurementIntent,
  transitionCrossChainProcurement,
  type BridgeQuote,
  type CrossChainProcurementIntent,
  type CrossChainProcurementState,
  type EvmAsset,
  type TransactionHash,
} from './cross-chain-procurement.js';

const GOAT_TOKEN: EvmAsset = {
  network: GOAT_MAINNET_NETWORK,
  tokenAddress: '0x1000000000000000000000000000000000000001',
  symbol: 'USDT',
  decimals: 6,
};

const BNB_TOKEN: EvmAsset = {
  network: BNB_CHAIN_MAINNET_NETWORK,
  tokenAddress: '0x2000000000000000000000000000000000000002',
  symbol: 'USDT',
  decimals: 6,
};

const hash = (digit: string) => `0x${digit.repeat(64)}` as TransactionHash;

function intent(): CrossChainProcurementIntent {
  return createCrossChainProcurementIntent({
    runId: 'run_cross_chain_1',
    funding: {
      role: 'CUSTOMER_FUNDING',
      asset: GOAT_TOKEN,
      payerAddress: '0x3000000000000000000000000000000000000003',
      maximumAtomicAmount: '250000',
    },
    target: {
      role: 'TARGET_PAYMENT',
      asset: BNB_TOKEN,
      scheme: 'exact',
      payerAddress: '0x6000000000000000000000000000000000000006',
      payToAddress: '0x4000000000000000000000000000000000000004',
      maximumAtomicAmount: '200000',
    },
    expiresAt: '2026-08-14T02:00:00.000Z',
  });
}

function quote(overrides: Partial<BridgeQuote> = {}): BridgeQuote {
  return {
    quoteId: 'bridge-quote-1',
    provider: 'reviewed-bridge',
    sourceAsset: GOAT_TOKEN,
    destinationAsset: BNB_TOKEN,
    amountInAtomic: '250000',
    minimumAmountOutAtomic: '200000',
    feeAtomic: '50000',
    expiresAt: '2026-08-14T01:50:00.000Z',
    providerData: { route: 'goat-bnb-usdt' },
    ...overrides,
  };
}

describe('cross-chain procurement intent', () => {
  it('keeps GOAT customer funding separate from the BNB target payment rail', () => {
    const value = intent();

    expect(value.mode).toBe('BRIDGE_THEN_PAY');
    expect(value.funding.asset.network).toBe('eip155:2345');
    expect(value.target.asset.network).toBe('eip155:56');
  });

  it('rejects a same-network intent masquerading as cross-chain procurement', () => {
    expect(() =>
      createCrossChainProcurementIntent({
        ...intent(),
        target: { ...intent().target, asset: { ...BNB_TOKEN, network: GOAT_MAINNET_NETWORK } },
      }),
    ).toThrow(/requires different funding and target networks/);
  });
});

describe('bridge quote authorization', () => {
  it('accepts an unexpired route delivering the exact destination asset with enough minimum output', () => {
    expect(() => assertBridgeQuotePayable(intent(), quote(), new Date('2026-08-14T01:45:00.000Z'))).not.toThrow();
  });

  it('rejects a wrapped substitute that the target did not advertise', () => {
    expect(() =>
      assertBridgeQuotePayable(
        intent(),
        quote({ destinationAsset: { ...BNB_TOKEN, tokenAddress: '0x5000000000000000000000000000000000000005' } }),
        new Date('2026-08-14T01:45:00.000Z'),
      ),
    ).toThrow(/destination asset does not match/);
  });

  it('rejects a route whose post-fee minimum cannot cover the target ceiling', () => {
    expect(() =>
      assertBridgeQuotePayable(
        intent(),
        quote({ minimumAmountOutAtomic: '199999' }),
        new Date('2026-08-14T01:45:00.000Z'),
      ),
    ).toThrow(/cannot cover the target payment ceiling/);
  });

  it('rejects an expired bridge quote', () => {
    expect(() => assertBridgeQuotePayable(intent(), quote(), new Date('2026-08-14T01:51:00.000Z'))).toThrow(
      /quote has expired/,
    );
  });
});

describe('bridge-then-pay state machine', () => {
  it('requires destination funding before creating the target payment', () => {
    const state: CrossChainProcurementState = {
      status: 'BRIDGING',
      sourceTransactionHash: hash('1'),
      transferId: 'transfer-1',
    };

    expect(() =>
      transitionCrossChainProcurement(state, { type: 'TARGET_PAYMENT_CREATED', paymentId: 'payment-1' }, '200000'),
    ).toThrow(/Cannot apply TARGET_PAYMENT_CREATED while cross-chain procurement is BRIDGING/);
  });

  it('advances from a GOAT lock through BNB funding, target payment, and GOAT attestation', () => {
    let state: CrossChainProcurementState = { status: 'AWAITING_SOURCE_LOCK' };
    state = transitionCrossChainProcurement(
      state,
      { type: 'SOURCE_FUNDS_LOCKED', sourceTransactionHash: hash('1') },
      '200000',
    );
    state = transitionCrossChainProcurement(state, { type: 'BRIDGE_SUBMITTED', transferId: 'transfer-1' }, '200000');
    state = transitionCrossChainProcurement(
      state,
      { type: 'DESTINATION_FUNDS_RECEIVED', destinationTransactionHash: hash('2'), amountReceivedAtomic: '205000' },
      '200000',
    );
    state = transitionCrossChainProcurement(
      state,
      { type: 'TARGET_PAYMENT_CREATED', paymentId: 'payment-1' },
      '200000',
    );
    state = transitionCrossChainProcurement(
      state,
      { type: 'TARGET_PAYMENT_CONFIRMED', targetPaymentTransactionHash: hash('3'), amountSpentAtomic: '190000' },
      '200000',
    );
    state = transitionCrossChainProcurement(
      state,
      { type: 'ATTESTATION_CONFIRMED', attestationTransactionHash: hash('4') },
      '200000',
    );

    expect(state).toEqual({
      status: 'ATTESTED',
      targetPaymentTransactionHash: hash('3'),
      attestationTransactionHash: hash('4'),
    });
  });

  it('refuses destination funding below the authorized target ceiling', () => {
    const state: CrossChainProcurementState = {
      status: 'BRIDGING',
      sourceTransactionHash: hash('1'),
      transferId: 'transfer-1',
    };

    expect(() =>
      transitionCrossChainProcurement(
        state,
        { type: 'DESTINATION_FUNDS_RECEIVED', destinationTransactionHash: hash('2'), amountReceivedAtomic: '199999' },
        '200000',
      ),
    ).toThrow(/Destination funding cannot cover/);
  });

  it('supports a controlled refund path after a bridge or target failure', () => {
    let state: CrossChainProcurementState = {
      status: 'BRIDGING',
      sourceTransactionHash: hash('1'),
      transferId: 'transfer-1',
    };
    state = transitionCrossChainProcurement(
      state,
      { type: 'REFUND_REQUESTED', reason: 'destination route timed out' },
      '200000',
    );
    state = transitionCrossChainProcurement(
      state,
      { type: 'REFUND_CONFIRMED', refundTransactionHash: hash('5') },
      '200000',
    );

    expect(state).toEqual({
      status: 'REFUNDED',
      reason: 'destination route timed out',
      refundTransactionHash: hash('5'),
    });
  });
});
