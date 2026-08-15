import { randomBytes } from 'node:crypto';

import { authorizePurchase, type PurchaseContext, type PurchaseIntent } from '@shipyard402/policy-engine';
import type { OrchestratorRunCheckpoint } from '@shipyard402/persistence-postgres';
import type { Quote } from '@shipyard402/quote-engine';
import type { CompiledTestPlan } from '@shipyard402/risk-classifier';
import type { RunStatus } from '@shipyard402/run-domain';
import { decodePaymentHeader } from '@shipyard402/x402-payments';

import { buildMandate } from '../mandate-builder.js';
import { PaymentSendAmbiguousError, ProcurementDeniedError } from './errors.js';
import type { OrchestratorPipelineDependencies } from './types.js';

const MANDATE_VALIDITY_SECONDS = 900;

/**
 * PROCURING: acquire a real, signed x402 payment for the run's own target and hand it downstream.
 *
 * Unlike the old flow, the orchestrator no longer broadcasts a payment transaction itself: in x402
 * the signed EIP-3009 authorization *is* the payment, and the target settles it on-chain the first
 * time it delivers. So the spend-once artifact to checkpoint is the `X-PAYMENT` header (and its
 * authorization nonce) -- checkpointed before it is ever presented, so a resumed run re-presents the
 * exact same payment instead of signing a second one.
 */
export async function runProcurementPhase(
  deps: OrchestratorPipelineDependencies,
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
    paymentHeaderName: 'x-payment' | 'payment-signature';
  }>
> {
  const endpoint = quote.request.x402Endpoint;
  const targetHost = new URL(endpoint).host;
  const toolAgentId = quote.request.targetAgentId;
  const chainId = quote.capabilitySnapshot.chainId;

  const deadlineEpochSeconds = Math.floor(now().getTime() / 1_000) + MANDATE_VALIDITY_SECONDS;
  const mandate = buildMandate(plan, { toolAgentId, host: targetHost }, deadlineEpochSeconds);

  // Authorize against the mandate before signing anything: the host allowlist (only the run's own
  // target) and the budget ceiling are the real controls. The exact price is discovered from the
  // target's 402 and re-checked against the ceiling by the payer client.
  const ceiling = mandate.maximumSinglePurchase;
  const intent: PurchaseIntent = {
    runId,
    toolAgentId,
    providerServiceId: toolAgentId,
    host: targetHost,
    atomicAmount: ceiling,
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

  // Resume path: a checkpointed X-PAYMENT is reused verbatim. Its nonce and amount are recovered by
  // decoding it, so no separate checkpoint fields are needed and the re-presented payment is
  // byte-identical to the one a prior attempt may have already settled.
  let purchaseReceipt = checkpoint.purchaseReceipt;
  let paymentTransactionHash = checkpoint.paymentTransactionHash;
  let purchaseAmount: bigint;

  if (purchaseReceipt) {
    const decoded = decodePaymentHeader(purchaseReceipt);
    if (!decoded) throw new Error(`Checkpointed x402 payment for run ${runId} is unreadable`);
    purchaseAmount = BigInt(decoded.payload.authorization.value);
    paymentTransactionHash = decoded.payload.authorization.nonce;
  } else {
    const nowSec = Math.floor(now().getTime() / 1_000);
    const acquired = await deps.x402Payer.acquire({
      endpoint,
      nonce: `0x${randomBytes(32).toString('hex')}`,
      validAfterSec: nowSec - 60,
      validBeforeSec: nowSec + MANDATE_VALIDITY_SECONDS,
      maxAmountAtomic: ceiling,
      expectedChainId: chainId,
      allowedAssets: deps.procurementAllowedAssets,
    });
    // Checkpoint before the payment is ever presented (execution phase), so a crash after this
    // point re-presents this exact payment rather than signing and settling a second one.
    const persisted = await deps.checkpointStore.merge(runId, {
      purchaseReceipt: acquired.paymentHeader,
      paymentTransactionHash: acquired.authorization.nonce,
      paymentHeaderName: 'x-payment',
    });
    purchaseReceipt = persisted.purchaseReceipt;
    paymentTransactionHash = persisted.paymentTransactionHash;
    if (!purchaseReceipt || !paymentTransactionHash) {
      throw new Error(`x402 authorization checkpoint for run ${runId} was not persisted`);
    }
    // Another lease holder may have won the COALESCE race with a different authorization. Always
    // execute the row PostgreSQL actually kept, never this attempt's losing local signature.
    const authoritative = decodePaymentHeader(purchaseReceipt);
    if (!authoritative) throw new Error(`Checkpointed x402 payment for run ${runId} is unreadable`);
    purchaseAmount = BigInt(authoritative.payload.authorization.value);
    paymentTransactionHash = authoritative.payload.authorization.nonce;
  }

  // Refund: the customer prepaid up to refundableToolBudgetAtomic; procurement above committed only
  // purchaseAmount. Same spend-once shape as before -- checkpointed so a resumed attempt reuses the
  // tx instead of double-paying.
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
        // Ambiguous, not retryable: the nonce is spent on-chain but no hash was checkpointed, so we
        // cannot tell a landed refund from a lost one. A plain Error here would be wrapped and
        // retried by the worker; this class is what routes it straight to manual reconciliation.
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

  return {
    purchaseAmount,
    paymentTransactionHash: paymentTransactionHash as `0x${string}`,
    purchaseReceipt,
    paymentHeaderName: 'x-payment',
  };
}
