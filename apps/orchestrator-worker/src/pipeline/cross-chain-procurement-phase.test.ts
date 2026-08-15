import { X402RequirementNotPayableError } from '@shipyard402/bnb-x402-client';
import type { OrchestratorRunCheckpoint } from '@shipyard402/persistence-postgres';
import type { Quote } from '@shipyard402/quote-engine';
import type { CompiledTestPlan } from '@shipyard402/risk-classifier';
import { GOAT_TO_BNB_USDT_STARGATE_ROUTE } from '@shipyard402/stargate-bridge-adapter';
import type { CrossChainBridgePort } from '@shipyard402/x402-payments';
import { describe, expect, it } from 'vitest';

import { resolveCrossChainPayer, runCrossChainProcurementPhase } from './cross-chain-procurement-phase.js';
import { BridgeDeliveryPendingError, ProcurementDeniedError } from './errors.js';
import type { CrossChainPayerRegistration, OrchestratorPipelineDependencies } from './types.js';

const NOW = new Date('2026-08-14T02:00:00.000Z');
const SOURCE_HASH = `0x${'11'.repeat(32)}` as const;
const DESTINATION_HASH = `0x${'22'.repeat(32)}` as const;
const PAYMENT_PROOF_HASH = `0x${'33'.repeat(32)}` as const;
/** What the target actually charged. Deliberately below the ceiling, which is what a real service does. */
const CHARGED_ATOMIC = '150000000000000000';
const CEILING_ATOMIC = '200000000000000000';

const quote = {
  request: {
    targetAgentId: 'agent:bnb-target',
    x402Endpoint: 'https://bnb-target.example/paid/resource',
  },
  targetChainId: 56,
} as Quote;

const plan = {
  riskLevel: 'MEDIUM',
  scenarios: ['payment-proof-replay'],
  toolBudgetAtomic: '300000',
  rationale: 'test',
} as CompiledTestPlan;

function checkpointStore(initial: OrchestratorRunCheckpoint = {}) {
  const store = {
    state: initial,
    async load() {
      return store.state;
    },
    async merge(_runId: string, patch: OrchestratorRunCheckpoint) {
      store.state = { ...store.state, ...patch };
      return store.state;
    },
  };
  return store;
}

type HarnessOptions = Readonly<{
  mode?: 'BRIDGE_THEN_PAY' | 'PREFUNDED';
  payerError?: unknown;
  chargedAtomic?: string;
}>;

function harness(options: HarnessOptions = {}) {
  const mode = options.mode ?? 'BRIDGE_THEN_PAY';
  const store = checkpointStore();
  let delivery: Awaited<ReturnType<CrossChainBridgePort['getStatus']>> = { status: 'PENDING' };
  let submitCalls = 0;
  let paymentCalls = 0;
  const bridge: CrossChainBridgePort = {
    async quote(intent) {
      return {
        quoteId: 'quote:stargate',
        provider: 'STARGATE_V2_LAYERZERO',
        sourceAsset: GOAT_TO_BNB_USDT_STARGATE_ROUTE.sourceAsset,
        destinationAsset: GOAT_TO_BNB_USDT_STARGATE_ROUTE.destinationAsset,
        amountInAtomic: intent.funding.maximumAtomicAmount,
        minimumAmountOutAtomic: intent.target.maximumAtomicAmount,
        feeAtomic: '1000',
        expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
        providerData: { route: GOAT_TO_BNB_USDT_STARGATE_ROUTE.id },
      };
    },
    async submit() {
      submitCalls += 1;
      return { transferId: SOURCE_HASH, sourceTransactionHash: SOURCE_HASH };
    },
    async getStatus() {
      return delivery;
    },
  };
  const endpoints: string[] = [];
  const payer: CrossChainPayerRegistration = {
    chainId: 56,
    mode,
    policyCostAtomic: '250000',
    targetPaymentAmountAtomic: CEILING_ATOMIC,
    settlementAsset: GOAT_TO_BNB_USDT_STARGATE_ROUTE.destinationAsset,
    destinationPayerAddress: '0x5000000000000000000000000000000000000005',
    targetPayToAddress: '0x6000000000000000000000000000000000000006',
    payerFor(endpoint: string) {
      endpoints.push(endpoint);
      return {
        async acquire() {
          paymentCalls += 1;
          if (options.payerError) throw options.payerError;
          return {
            paymentReceipt: 'checkpointed-payment-signature',
            paymentProofHash: PAYMENT_PROOF_HASH,
            amountAtomic: options.chargedAtomic ?? CHARGED_ATOMIC,
          };
        },
      } as unknown as ReturnType<CrossChainPayerRegistration['payerFor']>;
    },
    ...(mode === 'BRIDGE_THEN_PAY'
      ? {
          bridge: {
            port: bridge,
            provider: 'STARGATE_V2_LAYERZERO',
            fundingAsset: GOAT_TO_BNB_USDT_STARGATE_ROUTE.sourceAsset,
            sourceBridgeAmountAtomic: '250000',
            sourceBridgePayerAddress: '0x4000000000000000000000000000000000000004',
            maximumBridgeWaitSeconds: 1800,
          },
        }
      : {}),
  };
  const deps = {
    shipyardAgentId: 'shipyard:orchestrator',
    homeChainId: 48816,
    checkpointStore: store,
    crossChainPayers: [payer],
  } as unknown as OrchestratorPipelineDependencies;

  const run = (runId = 'run-bridge') =>
    runCrossChainProcurementPhase(deps, payer, runId, store.state, plan, quote, 'PROCURING', () => NOW);

  return {
    deps,
    store,
    run,
    payer,
    endpoints: () => endpoints,
    submitCalls: () => submitCalls,
    paymentCalls: () => paymentCalls,
    fundDestination() {
      delivery = {
        status: 'DESTINATION_FUNDED',
        destinationTransactionHash: DESTINATION_HASH,
        amountReceivedAtomic: '249000000000000000',
      };
    },
  };
}

describe('cross-chain procurement phase, BRIDGE_THEN_PAY', () => {
  it('checkpoints the source bridge and pauses without authorizing a payment before delivery', async () => {
    const value = harness();

    await expect(value.run()).rejects.toBeInstanceOf(BridgeDeliveryPendingError);

    expect(value.store.state).toMatchObject({
      bridgeProvider: 'STARGATE_V2_LAYERZERO',
      bridgeTransferId: SOURCE_HASH,
      bridgeSourceTransactionHash: SOURCE_HASH,
    });
    expect(value.submitCalls()).toBe(1);
    expect(value.paymentCalls()).toBe(0);
  });

  it('resumes the same transfer, verifies destination funding, and authorizes exactly once', async () => {
    const value = harness();
    await value.run().catch(() => undefined);
    value.fundDestination();

    const result = await value.run();

    expect(result).toEqual({
      purchaseAmount: BigInt(CHARGED_ATOMIC),
      paymentTransactionHash: PAYMENT_PROOF_HASH,
      purchaseReceipt: 'checkpointed-payment-signature',
      paymentHeaderName: 'payment-signature',
    });
    expect(value.store.state).toMatchObject({
      bridgeDestinationTransactionHash: DESTINATION_HASH,
      bridgeAmountReceivedAtomic: '249000000000000000',
      paymentHeaderName: 'payment-signature',
    });
    expect(value.submitCalls()).toBe(1);
    expect(value.paymentCalls()).toBe(1);
  });

  it('reports what the target actually charged, not the ceiling it was allowed to charge', async () => {
    // This value becomes the run's attested tool spend. Recording the ceiling would overstate every
    // run against a service that charges less than its allowance.
    const value = harness();
    await value.run().catch(() => undefined);
    value.fundDestination();

    const result = await value.run();

    expect(result.purchaseAmount).toBe(BigInt(CHARGED_ATOMIC));
    expect(result.purchaseAmount).not.toBe(BigInt(CEILING_ATOMIC));
    expect(value.store.state.targetPaymentAmountAtomic).toBe(CHARGED_ATOMIC);
  });

  it('replays a checkpointed authorization instead of paying again', async () => {
    const value = harness();
    await value.run().catch(() => undefined);
    value.fundDestination();
    await value.run();

    const again = await value.run();

    expect(again.purchaseAmount).toBe(BigInt(CHARGED_ATOMIC));
    expect(value.paymentCalls()).toBe(1);
  });
});

describe('cross-chain procurement phase, PREFUNDED', () => {
  it('pays straight away, with no bridge and no destination-funding wait', async () => {
    // The mode that makes a target reachable when it prices in an asset no bridge route delivers.
    const value = harness({ mode: 'PREFUNDED' });

    const result = await value.run('run-prefunded');

    expect(result).toEqual({
      purchaseAmount: BigInt(CHARGED_ATOMIC),
      paymentTransactionHash: PAYMENT_PROOF_HASH,
      purchaseReceipt: 'checkpointed-payment-signature',
      paymentHeaderName: 'payment-signature',
    });
    expect(value.submitCalls()).toBe(0);
    expect(value.paymentCalls()).toBe(1);
  });

  it('writes no bridge fields at all, so the UI cannot show a transfer that never happened', async () => {
    const value = harness({ mode: 'PREFUNDED' });

    await value.run('run-prefunded');

    expect(value.store.state.bridgeProvider).toBeUndefined();
    expect(value.store.state.bridgeTransferId).toBeUndefined();
    expect(value.store.state.bridgeSourceTransactionHash).toBeUndefined();
  });

  it('replays its checkpointed authorization too', async () => {
    const value = harness({ mode: 'PREFUNDED' });
    await value.run('run-prefunded');

    await value.run('run-prefunded');

    expect(value.paymentCalls()).toBe(1);
  });
});

describe('cross-chain procurement phase, unpayable targets', () => {
  it('turns an unmeetable challenge into a procurement denial carrying its reason codes', async () => {
    // Retrying cannot change the answer, so this must not look like a transient fault. The codes
    // say exactly what would have to change for the target to become payable.
    const value = harness({
      mode: 'PREFUNDED',
      payerError: new X402RequirementNotPayableError('https://bnb-target.example/paid/resource', [
        { index: 0, codes: ['ASSET_NOT_HELD'] },
        { index: 1, codes: ['AMOUNT_ABOVE_CEILING'] },
      ]),
    });

    await expect(value.run('run-unpayable')).rejects.toMatchObject({
      name: 'ProcurementDeniedError',
      denialCodes: ['ASSET_NOT_HELD', 'AMOUNT_ABOVE_CEILING'],
    });
  });

  it('leaves an unrelated payment failure as-is, so it can still be retried', async () => {
    const value = harness({ mode: 'PREFUNDED', payerError: new Error('RPC timeout') });

    await expect(value.run('run-transient')).rejects.toThrow(/RPC timeout/);
    await expect(value.run('run-transient')).rejects.not.toBeInstanceOf(ProcurementDeniedError);
  });
});

describe('resolveCrossChainPayer', () => {
  const deps = (payers: readonly CrossChainPayerRegistration[]) =>
    ({ homeChainId: 48816, crossChainPayers: payers }) as unknown as OrchestratorPipelineDependencies;
  const bnbPayer = { chainId: 56 } as CrossChainPayerRegistration;
  const quoteFor = (targetChainId?: number) => ({ ...quote, targetChainId }) as Quote;

  it('picks the payer registered for the run target’s own chain', () => {
    expect(resolveCrossChainPayer(deps([bnbPayer]), quoteFor(56))).toBe(bnbPayer);
  });

  it('uses no cross-chain payer when the target sits on this worker’s own chain', () => {
    expect(resolveCrossChainPayer(deps([bnbPayer]), quoteFor(48816))).toBeNull();
  });

  it('returns nothing for a target chain this worker cannot pay on', () => {
    // The caller turns this into a refusal; silently using the home payer would sign for the
    // wrong chain.
    expect(resolveCrossChainPayer(deps([bnbPayer]), quoteFor(8453))).toBeNull();
  });

  it('treats a quote written before target chains were recorded as same-chain', () => {
    expect(resolveCrossChainPayer(deps([bnbPayer]), quoteFor(undefined))).toBeNull();
  });
});
