import { describe, expect, it } from 'vitest';

import {
  createCrossChainProcurementIntent,
  type CrossChainProcurementIntent,
  type TransactionHash,
} from '@shipyard402/x402-payments';

import {
  InMemoryBridgeSubmissionStore,
  type DestinationReceiptPort,
  type LayerZeroDelivery,
  type LayerZeroScanPort,
  type StargateSendParameters,
  type StargateSourceChainPort,
} from './ports.js';
import { GOAT_TO_BNB_USDT_STARGATE_ROUTE } from './route.js';
import { StargateBridgeAdapter } from './stargate-bridge-adapter.js';

const SOURCE_HASH = `0x${'1'.repeat(64)}` as TransactionHash;
const DESTINATION_HASH = `0x${'2'.repeat(64)}` as TransactionHash;
const PAYER = '0x6000000000000000000000000000000000000006' as const;

function intent(overrides: Partial<CrossChainProcurementIntent['target']> = {}): CrossChainProcurementIntent {
  return createCrossChainProcurementIntent({
    runId: 'run_stargate_1',
    funding: {
      role: 'CUSTOMER_FUNDING',
      asset: GOAT_TO_BNB_USDT_STARGATE_ROUTE.sourceAsset,
      payerAddress: '0x3000000000000000000000000000000000000003',
      maximumAtomicAmount: '250000',
    },
    target: {
      role: 'TARGET_PAYMENT',
      asset: GOAT_TO_BNB_USDT_STARGATE_ROUTE.destinationAsset,
      scheme: 'exact',
      payerAddress: PAYER,
      payToAddress: '0x4000000000000000000000000000000000000004',
      maximumAtomicAmount: '200000000000000000',
      ...overrides,
    },
    expiresAt: '2026-08-14T03:00:00.000Z',
  });
}

class FakeSourceChain implements StargateSourceChainPort {
  receivedAtomic = '249000';
  nativeFeeWei = '1000';
  quoteInputs: StargateSendParameters[] = [];
  allowanceAmounts: string[] = [];
  sends: Array<StargateSendParameters & Readonly<{ nativeFeeWei: string }>> = [];
  sendError: Error | undefined;

  async quoteOft(input: StargateSendParameters) {
    this.quoteInputs.push(input);
    return { amountSentAtomic: input.amountInAtomic, amountReceivedAtomic: this.receivedAtomic };
  }

  async quoteSend(input: StargateSendParameters) {
    this.quoteInputs.push(input);
    return { nativeFeeWei: this.nativeFeeWei };
  }

  async ensureTokenAllowance(amountAtomic: string) {
    this.allowanceAmounts.push(amountAtomic);
  }

  async send(input: StargateSendParameters & Readonly<{ nativeFeeWei: string }>) {
    this.sends.push(input);
    if (this.sendError) throw this.sendError;
    return { transactionHash: SOURCE_HASH };
  }
}

class FakeScan implements LayerZeroScanPort {
  delivery: LayerZeroDelivery | null = null;

  async getDelivery() {
    return this.delivery;
  }
}

class FakeDestinationReceipts implements DestinationReceiptPort {
  amount: string | null = null;
  calls: Array<Parameters<DestinationReceiptPort['getTokenAmountReceived']>[0]> = [];

  async getTokenAmountReceived(input: Parameters<DestinationReceiptPort['getTokenAmountReceived']>[0]) {
    this.calls.push(input);
    return this.amount;
  }
}

function harness() {
  const sourceChain = new FakeSourceChain();
  const layerZeroScan = new FakeScan();
  const destinationReceipts = new FakeDestinationReceipts();
  const submissionStore = new InMemoryBridgeSubmissionStore();
  const adapter = new StargateBridgeAdapter({
    sourceChain,
    layerZeroScan,
    destinationReceipts,
    submissionStore,
    clock: () => new Date('2026-08-14T02:00:00.000Z'),
    maxNativeFeeWei: '1000000',
  });
  return { adapter, sourceChain, layerZeroScan, destinationReceipts };
}

describe('StargateBridgeAdapter', () => {
  it('quotes GOAT USDT into canonical BNB USDT for the destination payer without a swap', async () => {
    const { adapter, sourceChain } = harness();
    const quote = await adapter.quote(intent());

    expect(quote.sourceAsset.tokenAddress).toBe('0xE1AD845D93853fff44990aE0DcecD8575293681e');
    expect(quote.destinationAsset.tokenAddress).toBe('0x55d398326f99059fF775485246999027B3197955');
    expect(quote.minimumAmountOutAtomic).toBe('200000000000000000');
    expect(quote.feeAtomic).toBe('1000');
    expect(quote.providerData['destinationEndpointId']).toBe('30102');
    expect(sourceChain.quoteInputs[0]?.destinationRecipient).toBe(PAYER);
    expect(sourceChain.quoteInputs[0]?.minimumAmountOutAtomic).toBe('200000');
  });

  it('rejects a target advertising any token other than canonical BNB USDT', async () => {
    const { adapter } = harness();
    const nonCanonical = intent({
      asset: {
        ...GOAT_TO_BNB_USDT_STARGATE_ROUTE.destinationAsset,
        tokenAddress: '0x7000000000000000000000000000000000000007',
      },
    });

    await expect(adapter.quote(nonCanonical)).rejects.toThrow(/not canonical BNB Chain USDT/);
  });

  it('fails closed when the LayerZero native fee exceeds its configured ceiling', async () => {
    const { adapter, sourceChain } = harness();
    sourceChain.nativeFeeWei = '1000001';

    await expect(adapter.quote(intent())).rejects.toThrow(/fee exceeds the configured safety ceiling/);
  });

  it('submits only once for an idempotency key and reuses the recorded transaction', async () => {
    const { adapter, sourceChain } = harness();
    const value = intent();
    const quote = await adapter.quote(value);

    const first = await adapter.submit({ intent: value, quote, idempotencyKey: 'run-1:bridge' });
    const second = await adapter.submit({ intent: value, quote, idempotencyKey: 'run-1:bridge' });

    expect(first).toEqual({ sourceTransactionHash: SOURCE_HASH, transferId: SOURCE_HASH });
    expect(second).toEqual(first);
    expect(sourceChain.allowanceAmounts).toEqual(['250000']);
    expect(sourceChain.sends).toHaveLength(1);
    expect(sourceChain.sends[0]?.minimumAmountOutAtomic).toBe('200000');
  });

  it('keeps an ambiguous send claimed so a retry cannot double-bridge', async () => {
    const { adapter, sourceChain } = harness();
    const value = intent();
    const quote = await adapter.quote(value);
    sourceChain.sendError = new Error('RPC response lost');

    await expect(adapter.submit({ intent: value, quote, idempotencyKey: 'run-ambiguous:bridge' })).rejects.toThrow(
      'RPC response lost',
    );
    sourceChain.sendError = undefined;
    await expect(adapter.submit({ intent: value, quote, idempotencyKey: 'run-ambiguous:bridge' })).rejects.toThrow(
      /already being reconciled/,
    );
    expect(sourceChain.sends).toHaveLength(1);
  });

  it('waits for successful LayerZero delivery and verifies actual canonical USDT receipt on BNB', async () => {
    const { adapter, layerZeroScan, destinationReceipts } = harness();
    const value = intent();
    const quote = await adapter.quote(value);
    await adapter.submit({ intent: value, quote, idempotencyKey: 'run-1:bridge' });
    layerZeroScan.delivery = {
      status: 'DELIVERED',
      destinationStatus: 'SUCCEEDED',
      destinationTransactionHash: DESTINATION_HASH,
    };
    destinationReceipts.amount = '249000000000000000';

    await expect(adapter.getStatus(SOURCE_HASH)).resolves.toEqual({
      status: 'DESTINATION_FUNDED',
      destinationTransactionHash: DESTINATION_HASH,
      amountReceivedAtomic: '249000000000000000',
    });
    expect(destinationReceipts.calls[0]).toEqual({
      transactionHash: DESTINATION_HASH,
      tokenAddress: GOAT_TO_BNB_USDT_STARGATE_ROUTE.destinationAsset.tokenAddress,
      recipientAddress: PAYER,
    });
  });

  it('marks a delivered but underfunded destination receipt as failed', async () => {
    const { adapter, layerZeroScan, destinationReceipts } = harness();
    const value = intent();
    const quote = await adapter.quote(value);
    await adapter.submit({ intent: value, quote, idempotencyKey: 'run-1:bridge' });
    layerZeroScan.delivery = {
      status: 'DELIVERED',
      destinationStatus: 'SUCCEEDED',
      destinationTransactionHash: DESTINATION_HASH,
    };
    destinationReceipts.amount = '199999999999999999';

    await expect(adapter.getStatus(SOURCE_HASH)).resolves.toMatchObject({
      status: 'FAILED',
      amountReceivedAtomic: '199999999999999999',
      failureReason: expect.stringMatching(/below the authorized/),
    });
  });

  it('does not treat an inflight LayerZero message as destination funds', async () => {
    const { adapter, layerZeroScan } = harness();
    const value = intent();
    const quote = await adapter.quote(value);
    await adapter.submit({ intent: value, quote, idempotencyKey: 'run-1:bridge' });
    layerZeroScan.delivery = { status: 'INFLIGHT' };

    await expect(adapter.getStatus(SOURCE_HASH)).resolves.toEqual({ status: 'PENDING' });
  });
});
