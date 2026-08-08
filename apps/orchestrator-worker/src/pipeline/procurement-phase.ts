import { authorizePurchase, type PurchaseContext, type PurchaseIntent } from '@shipyard402/policy-engine';
import type { OrchestratorRunCheckpoint } from '@shipyard402/persistence-postgres';
import type { Quote } from '@shipyard402/quote-engine';
import type { CompiledTestPlan } from '@shipyard402/risk-classifier';
import type { RunStatus } from '@shipyard402/run-domain';

import { buildMandate } from '../mandate-builder.js';
import { PaymentSendAmbiguousError, ProcurementDeniedError } from './errors.js';
import type { OrchestratorPipelineDependencies } from './types.js';

const MANDATE_VALIDITY_SECONDS = 900;

/** PROCURING: compile the mandate, pay for the tool call, fetch the earned receipt, and (if configured) refund the unspent tool budget -- all spend-once side effects, checkpointed as they happen. */
export async function runProcurementPhase(
  deps: OrchestratorPipelineDependencies,
  runId: string,
  checkpoint: OrchestratorRunCheckpoint,
  plan: CompiledTestPlan,
  quote: Quote,
  currentRunStatus: RunStatus,
  now: () => Date,
): Promise<Readonly<{ purchaseAmount: bigint; paymentTransactionHash: `0x${string}`; purchaseReceipt: string }>> {
  const deadlineEpochSeconds = Math.floor(now().getTime() / 1_000) + MANDATE_VALIDITY_SECONDS;
  const mandate = buildMandate(
    plan,
    { toolAgentId: deps.demoTarget.toolAgentId, host: deps.demoTarget.host },
    deadlineEpochSeconds,
  );

  const purchaseAmount = BigInt(deps.demoTarget.minimumAtomicAmount);
  if (purchaseAmount > BigInt(mandate.maximumSinglePurchase)) {
    throw new Error('Demo target minimum purchase amount exceeds the compiled mandate ceiling');
  }

  // The procurement payment and the receipt it earns are each spend-once, real side effects
  // (a second on-chain send double-spends; a second /purchase call is rejected by the demo
  // target's own replay guard on that transaction hash) — checkpoint them immediately so a
  // resumed attempt reuses what already happened instead of repeating it.
  let paymentTransactionHash = checkpoint.paymentTransactionHash;
  if (!paymentTransactionHash) {
    const intent: PurchaseIntent = {
      runId,
      toolAgentId: deps.demoTarget.toolAgentId,
      providerServiceId: deps.demoTarget.toolAgentId,
      host: deps.demoTarget.host,
      atomicAmount: purchaseAmount.toString(),
      idempotencyKey: `orchestrator:${runId}:procure:1`,
    };
    const purchaseContext: PurchaseContext = {
      nowEpochSeconds: Math.floor(now().getTime() / 1_000),
      runStatus: currentRunStatus,
      currentTotalSpend: '0',
      completedToolCalls: 0,
      priorAttemptsForTool: 0,
      shipyardAgentId: deps.shipyardAgentId,
      shipyardControlledHosts: [],
      additionalSpendApproved: false,
    };
    const authorization = authorizePurchase(mandate, intent, purchaseContext);
    if (!authorization.authorized) throw new ProcurementDeniedError(authorization.denialCodes);

    let paymentNonce = checkpoint.paymentNonce;
    if (paymentNonce === undefined) {
      const reserved = await deps.paymentSender.reserveNonce();
      // merge() can lose a race to a concurrent resumed attempt of this same run (e.g. a
      // reclaimed job lease while the original worker is still alive and slow) -- COALESCE
      // keeps whichever value landed first, and the returned row is the only way to find out
      // which one that was. Using the local `reserved` value here regardless would let the
      // loser broadcast a second, differently-nonced payment: the exact double-spend this
      // checkpointing exists to prevent.
      const persisted = await deps.checkpointStore.merge(runId, { paymentNonce: reserved });
      paymentNonce = persisted.paymentNonce ?? reserved;
    }
    if (await deps.paymentSender.isNonceConsumed(paymentNonce)) {
      throw new PaymentSendAmbiguousError(runId, paymentNonce, 'payment');
    }

    paymentTransactionHash = await deps.paymentSender.sendPayment({
      toAddress: deps.demoTarget.receivingAddress,
      valueWei: purchaseAmount,
      nonce: paymentNonce,
    });
    await deps.checkpointStore.merge(runId, { paymentTransactionHash });
  }
  await deps.paymentSender.waitForConfirmation(paymentTransactionHash, deps.demoTarget.minimumConfirmations);

  let purchaseReceipt = checkpoint.purchaseReceipt;
  if (!purchaseReceipt) {
    const purchase = await deps.purchaseClient.purchase(paymentTransactionHash);
    purchaseReceipt = purchase.receipt;
    await deps.checkpointStore.merge(runId, { purchaseReceipt });
  }

  // Refund: the customer prepaid up to refundableToolBudgetAtomic; procurement above only
  // actually spent purchaseAmount. Same spend-once shape as the payment/attestation sends, so
  // it is checkpointed the same way -- a resumed attempt reuses the tx instead of double-paying.
  if (deps.refundSender) {
    const refundAmount = BigInt(quote.refundableToolBudgetAtomic) - purchaseAmount;
    if (refundAmount > 0n && !checkpoint.refundTransactionHash) {
      let refundNonce = checkpoint.refundNonce;
      if (refundNonce === undefined) {
        const reserved = await deps.refundSender.reserveNonce();
        const persisted = await deps.checkpointStore.merge(runId, { refundNonce: reserved });
        refundNonce = persisted.refundNonce ?? reserved;
      }
      if (await deps.refundSender.isNonceConsumed(refundNonce)) {
        throw new PaymentSendAmbiguousError(runId, refundNonce, 'refund');
      }

      const refundTransactionHash = await deps.refundSender.sendRefund({
        tokenAddress: quote.capabilitySnapshot.tokenAddress as `0x${string}`,
        toAddress: quote.request.requesterAddress as `0x${string}`,
        valueAtomic: refundAmount,
        nonce: refundNonce,
      });
      await deps.checkpointStore.merge(runId, { refundTransactionHash });
    }
  }

  return { purchaseAmount, paymentTransactionHash, purchaseReceipt };
}
