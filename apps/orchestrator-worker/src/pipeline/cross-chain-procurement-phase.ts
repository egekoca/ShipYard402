import { X402RequirementNotPayableError } from '@shipyard402/bnb-x402-client';
import { authorizePurchase, type PurchaseContext, type PurchaseIntent } from '@shipyard402/policy-engine';
import type { OrchestratorRunCheckpoint } from '@shipyard402/persistence-postgres';
import type { Quote } from '@shipyard402/quote-engine';
import type { CompiledTestPlan } from '@shipyard402/risk-classifier';
import type { RunStatus } from '@shipyard402/run-domain';
import { createCrossChainProcurementIntent } from '@shipyard402/x402-payments';

import { buildMandate } from '../mandate-builder.js';
import { BridgeDeliveryPendingError, ProcurementDeniedError } from './errors.js';
import type { CrossChainPayerRegistration, OrchestratorPipelineDependencies } from './types.js';

const MANDATE_VALIDITY_SECONDS = 900;

const BRIDGE_LEG_INDEX = 0;
const PAYMENT_LEG_INDEX = 1;

/**
 * Records one step of the run's money movement. Deliberately swallowing its own failure: legs exist
 * so a person can watch what happened, and losing that view must never abort a payment that is
 * otherwise fine, nor make a retry look necessary when nothing financial went wrong.
 */
async function recordLeg(
  deps: OrchestratorPipelineDependencies,
  leg: Parameters<NonNullable<OrchestratorPipelineDependencies['settlementLegs']>['record']>[0],
): Promise<void> {
  if (!deps.settlementLegs) return;
  try {
    await deps.settlementLegs.record(leg);
  } catch (error) {
    console.error(`[orchestrator-worker] could not record settlement leg for ${leg.runId}:`, error);
  }
}

type CrossChainConfig = CrossChainPayerRegistration;

/**
 * Whether this run's target settles somewhere other than the chain this worker funds on.
 *
 * Read from the quote, which froze the target's chain from the services catalog at quote time --
 * not from the request, which is client-supplied. A quote written before that existed carries no
 * chain and is treated as same-chain, which is what those runs actually were.
 */
export function targetIsRemote(deps: OrchestratorPipelineDependencies, quote: Quote): boolean {
  return quote.targetChainId !== undefined && quote.targetChainId !== deps.homeChainId;
}

/** The payer registered for this run's target chain, or null when this worker cannot pay there. */
export function resolveCrossChainPayer(
  deps: OrchestratorPipelineDependencies,
  quote: Quote,
): CrossChainPayerRegistration | null {
  if (!targetIsRemote(deps, quote)) return null;
  return deps.crossChainPayers?.find((payer) => payer.chainId === quote.targetChainId) ?? null;
}

/**
 * Buys the run's paid resource on a chain other than the one the customer funded on.
 *
 * In BRIDGE_THEN_PAY the destination payer is funded first, and no payment may be attempted until
 * that delivery has been observed on the destination chain. In PREFUNDED the payer already holds
 * the settlement asset, so funding is skipped entirely -- which is the only way to reach a target
 * priced in an asset no bridge route delivers.
 *
 * Both paths converge on one x402 authorization, checkpointed so a re-claimed job replays it
 * rather than paying twice.
 */
export async function runCrossChainProcurementPhase(
  deps: OrchestratorPipelineDependencies,
  crossChain: CrossChainPayerRegistration,
  runId: string,
  checkpoint: OrchestratorRunCheckpoint,
  plan: CompiledTestPlan,
  quote: Quote,
  currentRunStatus: RunStatus,
  now: () => Date,
): Promise<
  Readonly<{
    purchaseAmount: bigint;
    paymentTransactionHash: `0x${string}`;
    purchaseReceipt: string;
    paymentHeaderName: 'payment-signature';
  }>
> {
  const nowSec = Math.floor(now().getTime() / 1_000);
  const targetEndpoint = quote.request.x402Endpoint;
  const targetHost = new URL(targetEndpoint).host;

  authorizeProcurement(deps, crossChain, runId, plan, quote, targetHost, currentRunStatus, nowSec);

  if (crossChain.mode === 'BRIDGE_THEN_PAY') {
    await fundDestinationByBridge(deps, crossChain, runId, checkpoint, nowSec, now);
  }

  await recordLeg(deps, {
    runId,
    legIndex: PAYMENT_LEG_INDEX,
    kind: 'TARGET_PAYMENT',
    network: crossChain.settlementAsset.network,
    assetSymbol: crossChain.settlementAsset.symbol,
    assetDecimals: crossChain.settlementAsset.decimals,
    assetAddress: crossChain.settlementAsset.tokenAddress,
    status: 'PENDING',
    provider: 'x402',
    detail: { endpoint: targetEndpoint, scheme: 'exact' },
  });

  const { receipt, proofHash, amountAtomic } = await authorizeTargetPayment(
    deps,
    crossChain,
    runId,
    checkpoint,
    targetEndpoint,
  );

  await recordLeg(deps, {
    runId,
    legIndex: PAYMENT_LEG_INDEX,
    kind: 'TARGET_PAYMENT',
    network: crossChain.settlementAsset.network,
    assetSymbol: crossChain.settlementAsset.symbol,
    assetDecimals: crossChain.settlementAsset.decimals,
    assetAddress: crossChain.settlementAsset.tokenAddress,
    status: 'CONFIRMED',
    amountAtomic,
    provider: 'x402',
    detail: { endpoint: targetEndpoint, scheme: 'exact' },
  });

  return {
    // The amount actually settled, never the ceiling: this becomes the run's attested tool spend,
    // and a target that charges less than the ceiling must not be recorded as having charged it.
    purchaseAmount: BigInt(amountAtomic),
    paymentTransactionHash: proofHash,
    purchaseReceipt: receipt,
    paymentHeaderName: 'payment-signature',
  };
}

/** Runs the purchase through the policy engine, on the rail whose budget the mandate is denominated in. */
function authorizeProcurement(
  deps: OrchestratorPipelineDependencies,
  crossChain: CrossChainConfig,
  runId: string,
  plan: CompiledTestPlan,
  quote: Quote,
  targetHost: string,
  currentRunStatus: RunStatus,
  nowSec: number,
): void {
  const mandate = buildMandate(
    plan,
    { toolAgentId: quote.request.targetAgentId, host: targetHost },
    nowSec + MANDATE_VALIDITY_SECONDS,
  );
  const intent: PurchaseIntent = {
    runId,
    toolAgentId: quote.request.targetAgentId,
    providerServiceId: quote.request.targetAgentId,
    host: targetHost,
    // Always the funding rail's units, never the destination amount: the mandate's budget is
    // denominated in the run's own quote, and a BNB 18-decimal figure compared against a GOAT
    // 6-decimal budget would blow through every limit while looking like a normal purchase.
    atomicAmount: crossChain.policyCostAtomic,
    idempotencyKey: `orchestrator:${runId}:${crossChain.bridge ? 'bridge' : 'prefunded'}:1`,
  };
  const context: PurchaseContext = {
    nowEpochSeconds: nowSec,
    runStatus: currentRunStatus,
    currentTotalSpend: '0',
    completedToolCalls: 0,
    priorAttemptsForTool: 0,
    shipyardAgentId: deps.shipyardAgentId,
    shipyardControlledHosts: [],
    additionalSpendApproved: false,
  };
  const authorization = authorizePurchase(mandate, intent, context);
  if (!authorization.authorized) throw new ProcurementDeniedError(authorization.denialCodes);
}

/** Moves funds to the destination payer and refuses to continue until delivery is observed there. */
async function fundDestinationByBridge(
  deps: OrchestratorPipelineDependencies,
  crossChain: CrossChainConfig,
  runId: string,
  checkpoint: OrchestratorRunCheckpoint,
  nowSec: number,
  now: () => Date,
): Promise<void> {
  const bridge = crossChain.bridge;
  if (!bridge) throw new Error('BRIDGE_THEN_PAY procurement is missing its bridge configuration');

  const procurementIntent = createCrossChainProcurementIntent({
    runId,
    funding: {
      role: 'CUSTOMER_FUNDING',
      asset: bridge.fundingAsset,
      payerAddress: bridge.sourceBridgePayerAddress,
      maximumAtomicAmount: bridge.sourceBridgeAmountAtomic,
    },
    // The settlement asset is the payer's own, not whatever the route happens to carry: a route
    // that delivered something else would fail the bridge adapter's quote check before funds move,
    // instead of stranding them on the destination chain in an asset the target does not accept.
    target: {
      role: 'TARGET_PAYMENT',
      asset: crossChain.settlementAsset,
      scheme: 'exact',
      payerAddress: crossChain.destinationPayerAddress,
      ...(crossChain.targetPayToAddress ? { payToAddress: crossChain.targetPayToAddress } : {}),
      maximumAtomicAmount: crossChain.targetPaymentAmountAtomic,
    },
    expiresAt: new Date(now().getTime() + MANDATE_VALIDITY_SECONDS * 1_000).toISOString(),
  });

  let transferId = checkpoint.bridgeTransferId;
  let sourceTransactionHash = checkpoint.bridgeSourceTransactionHash;
  let bridgeSubmittedAt = checkpoint.bridgeSubmittedAt;
  if (!transferId || !sourceTransactionHash) {
    const bridgeQuote = await bridge.port.quote(procurementIntent);
    const submitted = await bridge.port.submit({
      intent: procurementIntent,
      quote: bridgeQuote,
      idempotencyKey: `orchestrator:${runId}:bridge:1`,
    });
    const persisted = await deps.checkpointStore.merge(runId, {
      bridgeProvider: bridge.provider,
      bridgeTransferId: submitted.transferId,
      bridgeSourceTransactionHash: submitted.sourceTransactionHash,
      bridgeSubmittedAt: nowSec,
    });
    transferId = persisted.bridgeTransferId;
    sourceTransactionHash = persisted.bridgeSourceTransactionHash;
    bridgeSubmittedAt = persisted.bridgeSubmittedAt;
    if (!transferId || !sourceTransactionHash || bridgeSubmittedAt === undefined) {
      throw new Error('Bridge submission checkpoint was not persisted');
    }
    await recordLeg(deps, {
      runId,
      legIndex: BRIDGE_LEG_INDEX,
      kind: 'BRIDGE',
      network: bridge.fundingAsset.network,
      assetSymbol: bridge.fundingAsset.symbol,
      assetDecimals: bridge.fundingAsset.decimals,
      assetAddress: bridge.fundingAsset.tokenAddress,
      status: 'SUBMITTED',
      transactionHash: sourceTransactionHash,
      amountAtomic: bridge.sourceBridgeAmountAtomic,
      provider: bridge.provider,
      detail: { destinationNetwork: crossChain.settlementAsset.network },
    });
  }

  let destinationTransactionHash = checkpoint.bridgeDestinationTransactionHash;
  let amountReceivedAtomic = checkpoint.bridgeAmountReceivedAtomic;
  if (!destinationTransactionHash || !amountReceivedAtomic) {
    if (bridgeSubmittedAt !== undefined && nowSec - bridgeSubmittedAt > bridge.maximumBridgeWaitSeconds) {
      throw new Error('Bridge exceeded the configured delivery timeout');
    }
    const status = await bridge.port.getStatus(transferId);
    if (status.status === 'PENDING') throw new BridgeDeliveryPendingError(runId);
    if (status.status !== 'DESTINATION_FUNDED' || !status.destinationTransactionHash || !status.amountReceivedAtomic) {
      throw new Error(status.failureReason ?? `Bridge ended in ${status.status}`);
    }
    const persisted = await deps.checkpointStore.merge(runId, {
      bridgeDestinationTransactionHash: status.destinationTransactionHash,
      bridgeAmountReceivedAtomic: status.amountReceivedAtomic,
    });
    destinationTransactionHash = persisted.bridgeDestinationTransactionHash;
    amountReceivedAtomic = persisted.bridgeAmountReceivedAtomic;
    if (!destinationTransactionHash || !amountReceivedAtomic) {
      throw new Error('Destination funding checkpoint was not persisted');
    }
    await recordLeg(deps, {
      runId,
      legIndex: BRIDGE_LEG_INDEX,
      kind: 'BRIDGE',
      network: bridge.fundingAsset.network,
      assetSymbol: bridge.fundingAsset.symbol,
      assetDecimals: bridge.fundingAsset.decimals,
      assetAddress: bridge.fundingAsset.tokenAddress,
      status: 'CONFIRMED',
      amountAtomic: amountReceivedAtomic,
      provider: bridge.provider,
      detail: {
        destinationNetwork: crossChain.settlementAsset.network,
        destinationTransactionHash,
        destinationAssetSymbol: crossChain.settlementAsset.symbol,
      },
    });
  }

  if (BigInt(amountReceivedAtomic) < BigInt(crossChain.targetPaymentAmountAtomic)) {
    throw new Error('Checkpointed destination funding cannot cover the target payment ceiling');
  }
}

/** Signs one x402 authorization for the target, or replays the checkpointed one. */
async function authorizeTargetPayment(
  deps: OrchestratorPipelineDependencies,
  crossChain: CrossChainConfig,
  runId: string,
  checkpoint: OrchestratorRunCheckpoint,
  targetEndpoint: string,
): Promise<Readonly<{ receipt: string; proofHash: `0x${string}`; amountAtomic: string }>> {
  if (checkpoint.purchaseReceipt && checkpoint.paymentTransactionHash && checkpoint.targetPaymentAmountAtomic) {
    return {
      receipt: checkpoint.purchaseReceipt,
      proofHash: checkpoint.paymentTransactionHash,
      amountAtomic: checkpoint.targetPaymentAmountAtomic,
    };
  }

  let payment: Awaited<ReturnType<ReturnType<CrossChainConfig['payerFor']>['acquire']>>;
  try {
    payment = await crossChain.payerFor(targetEndpoint).acquire(`orchestrator:${runId}:target-x402:1`);
  } catch (error) {
    // A target whose terms this payer cannot meet is a procurement denial, not a transient fault:
    // retrying cannot change the answer, and the codes say precisely what would have to change
    // (a settlement asset we hold, a higher ceiling, a transfer method the client can sign).
    if (error instanceof X402RequirementNotPayableError) {
      await recordLeg(deps, {
        runId,
        legIndex: PAYMENT_LEG_INDEX,
        kind: 'TARGET_PAYMENT',
        network: crossChain.settlementAsset.network,
        assetSymbol: crossChain.settlementAsset.symbol,
        assetDecimals: crossChain.settlementAsset.decimals,
        assetAddress: crossChain.settlementAsset.tokenAddress,
        status: 'FAILED',
        provider: 'x402',
        detail: { endpoint: targetEndpoint, rejectionCodes: error.codes },
      });
      throw new ProcurementDeniedError(error.codes);
    }
    throw error;
  }

  const persisted = await deps.checkpointStore.merge(runId, {
    purchaseReceipt: payment.paymentReceipt,
    paymentTransactionHash: payment.paymentProofHash,
    targetPaymentAmountAtomic: payment.amountAtomic,
    paymentHeaderName: 'payment-signature',
  });
  if (!persisted.purchaseReceipt || !persisted.paymentTransactionHash || !persisted.targetPaymentAmountAtomic) {
    throw new Error('Target x402 authorization checkpoint was not persisted');
  }
  return {
    receipt: persisted.purchaseReceipt,
    proofHash: persisted.paymentTransactionHash,
    amountAtomic: persisted.targetPaymentAmountAtomic,
  };
}
