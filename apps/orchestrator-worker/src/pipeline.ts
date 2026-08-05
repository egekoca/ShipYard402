import type { AttestationRecord, EvidencePack, OrchestratorRunCheckpoint } from '@shipyard402/persistence-postgres';
import { authorizePurchase, type PurchaseContext, type PurchaseIntent } from '@shipyard402/policy-engine';
import {
  InvalidCredentialRejectionRunner,
  ProtectedDeliveryReplayRunner,
  verifyResponseSignature,
  type ProtectedDeliveryClient,
  type ReplayEvidence,
  type ReplayScenario,
} from '@shipyard402/protected-delivery-runner';
import { compileTestPlan, type CompiledTestPlan, type RiskClassifier } from '@shipyard402/risk-classifier';
import { transitionRun, type RunActor, type RunStatus } from '@shipyard402/run-domain';
import { keccak256, toUtf8Bytes } from 'ethers';

import { buildAttestationInput } from './attestation-builder.js';
import { buildEvidencePack, buildUnsignedToolReceipt, canonicalEvidencePackContent } from './evidence-builder.js';
import type { EvidencePublisherPort } from './ipfs-publisher.js';
import { buildMandate } from './mandate-builder.js';
import type {
  NativePaymentSender,
  PurchaseClient,
  QuoteRepositoryPort,
  RefundSender,
  RegistryAttestor,
  RunRepositoryPort,
  ToolReceiptSigner,
} from './ports.js';

const PAID_RESOURCE_ROUTE = '/paid/resource';
const MANDATE_VALIDITY_SECONDS = 900;
const ZERO_CHAIN_TRANSACTION_HASH = `0x${'0'.repeat(64)}` as const;

type ScenarioExecutionContext = Readonly<{
  targetServiceId: string;
  targetVersionHash: `0x${string}`;
  policyHash: `0x${string}`;
  paymentReceipt: string;
  paymentTransactionHash: `0x${string}`;
  deliveryClient: ProtectedDeliveryClient;
}>;

type ScenarioResult = Readonly<{ evidence: ReplayEvidence; chainTransactionHash: `0x${string}` }>;

/**
 * What the pipeline can actually run, keyed by scenario ID. compileTestPlan's output can contain
 * IDs beyond this set (the AI proposes freely, see risk-classifier's availableScenarios prompt
 * field) -- those are skipped, not executed, since there is nothing registered to run them.
 */
const SCENARIO_EXECUTORS: Readonly<Record<string, (ctx: ScenarioExecutionContext) => Promise<ScenarioResult>>> = {
  'payment-proof-replay': async (ctx) => {
    const scenario: ReplayScenario = {
      scenarioId: 'payment-proof-replay',
      targetServiceId: ctx.targetServiceId,
      targetVersionHash: ctx.targetVersionHash,
      policyHash: ctx.policyHash,
      method: 'GET',
      route: PAID_RESOURCE_ROUTE,
      paymentReceipt: ctx.paymentReceipt,
      paymentProofHash: keccak256(toUtf8Bytes(ctx.paymentTransactionHash)) as `0x${string}`,
    };
    return {
      evidence: await new ProtectedDeliveryReplayRunner(ctx.deliveryClient).run(scenario),
      chainTransactionHash: ctx.paymentTransactionHash,
    };
  },
  'unpaid-access-denial': async (ctx) => ({
    evidence: await new InvalidCredentialRejectionRunner(ctx.deliveryClient).run({
      scenarioId: 'unpaid-access-denial',
      targetServiceId: ctx.targetServiceId,
      targetVersionHash: ctx.targetVersionHash,
      policyHash: ctx.policyHash,
      method: 'GET',
      route: PAID_RESOURCE_ROUTE,
    }),
    // No payment happens in this scenario, so there is no real transaction to attach the receipt to.
    chainTransactionHash: ZERO_CHAIN_TRANSACTION_HASH,
  }),
  'tampered-receipt-rejection': async (ctx) => ({
    evidence: await new InvalidCredentialRejectionRunner(ctx.deliveryClient).run({
      scenarioId: 'tampered-receipt-rejection',
      targetServiceId: ctx.targetServiceId,
      targetVersionHash: ctx.targetVersionHash,
      policyHash: ctx.policyHash,
      method: 'GET',
      route: PAID_RESOURCE_ROUTE,
      // Deterministically corrupt the real earned receipt -- guaranteed to fail the target's
      // integrity check without needing to know its internal format.
      presentedReceipt: `${ctx.paymentReceipt}-tampered`,
    }),
    // No new payment -- this reuses (a corrupted form of) the same receipt from procurement.
    chainTransactionHash: ZERO_CHAIN_TRANSACTION_HASH,
  }),
};

function aggregateScenarioResult(results: readonly ReplayEvidence[]): 'PASS' | 'FAIL' | 'INCONCLUSIVE' {
  if (results.some((result) => result.result === 'FAIL')) return 'FAIL';
  if (results.some((result) => result.result === 'INCONCLUSIVE')) return 'INCONCLUSIVE';
  return 'PASS';
}

/**
 * Opt-in cross-check: if the provider is registered to sign its responses (DemoTargetConfig.
 * providerSignerAddress), a PASS is only trustworthy if every attempt with a real response is
 * actually signed by that address -- otherwise a compromised or buggy fetch client could fabricate
 * "the target rejected the replay" without ever really talking to the target. A FAIL is left as-is:
 * the practical risk this guards against is a forged PASS hiding a real vulnerability, not a forged
 * FAIL hiding a real pass (nothing is gained by fabricating a worse result).
 */
function verifyScenarioProvenance(
  results: readonly ScenarioResult[],
  expectedSigner: `0x${string}` | undefined,
): readonly ScenarioResult[] {
  if (!expectedSigner) return results;
  return results.map((result) => {
    if (result.evidence.result !== 'PASS') return result;
    const unverified = result.evidence.attempts.some((attempt) => (
      attempt.responseHash !== undefined &&
      !verifyResponseSignature(attempt.responseHash, attempt.providerSignature, expectedSigner)
    ));
    if (!unverified) return result;
    return {
      ...result,
      evidence: { ...result.evidence, result: 'INCONCLUSIVE', failureCode: 'PROVIDER_SIGNATURE_INVALID' },
    };
  });
}

/**
 * Statuses this pipeline can (re)enter and drive forward. A job may be re-claimed after a crash
 * or a transient failure at any of these statuses — the pipeline resumes from whatever the run's
 * persisted status and checkpoint already reflect, rather than requiring a fresh FUNDED run.
 */
const RESUMABLE_STATUSES = new Set<RunStatus>([
  'FUNDED', 'ANALYZING', 'PLAN_COMPILED', 'PROCURING', 'EXECUTING', 'EVIDENCE_BUILDING', 'ATTESTING',
]);

const STATUS_ORDER: readonly RunStatus[] = [
  'FUNDED', 'ANALYZING', 'PLAN_COMPILED', 'PROCURING', 'EXECUTING', 'EVIDENCE_BUILDING', 'ATTESTING',
];

export interface EvidencePackStorePort {
  put(pack: EvidencePack): Promise<void>;
  getByRunId(runId: string): Promise<EvidencePack | null>;
}

export interface AttestationStorePort {
  put(record: AttestationRecord): Promise<void>;
  getByRunId(runId: string): Promise<AttestationRecord | null>;
}

export interface CheckpointStorePort {
  load(runId: string): Promise<OrchestratorRunCheckpoint>;
  merge(runId: string, patch: OrchestratorRunCheckpoint): Promise<void>;
}

export type DemoTargetConfig = Readonly<{
  baseUrl: string;
  host: string;
  toolAgentId: string;
  receivingAddress: `0x${string}`;
  minimumAtomicAmount: string;
  minimumConfirmations: number;
  toolVersion: string;
  chainId: number;
  /**
   * The registered signer address this provider is expected to sign its /paid/resource responses
   * with. Verification is opt-in: unset means the provider doesn't sign, so nothing is checked.
   * Set means every scenario result gets cross-checked against it (see verifyScenarioProvenance).
   */
  providerSignerAddress?: `0x${string}`;
}>;

export type OrchestratorPipelineDependencies = Readonly<{
  runRepository: RunRepositoryPort;
  quoteRepository: QuoteRepositoryPort;
  riskClassifier: RiskClassifier;
  mandatoryScenarios: readonly string[];
  shipyardAgentId: string;
  demoTarget: DemoTargetConfig;
  deliveryClient: ProtectedDeliveryClient;
  paymentSender: NativePaymentSender;
  /**
   * Undefined until real customer funds exist to refund from -- GOAT Flow merchant onboarding is
   * still simulated (see docs/business-model.md), so there is nothing to send back yet. Wiring
   * this in is what activates the refund step below; leaving it unset is a deliberate no-op, not
   * a silent failure.
   */
  refundSender?: RefundSender;
  purchaseClient: PurchaseClient;
  toolReceiptSigner: ToolReceiptSigner;
  evidencePackStore: EvidencePackStorePort;
  evidencePublisher: EvidencePublisherPort;
  attestor: RegistryAttestor;
  attestationStore: AttestationStorePort;
  checkpointStore: CheckpointStorePort;
  now?: () => Date;
}>;

export class RunNotReadyForOrchestrationError extends Error {
  constructor(status: RunStatus) {
    super(`Run cannot be orchestrated from status: ${status}`);
    this.name = 'RunNotReadyForOrchestrationError';
  }
}

export class ProcurementDeniedError extends Error {
  readonly denialCodes: readonly string[];

  constructor(denialCodes: readonly string[]) {
    super(`Procurement purchase was denied: ${denialCodes.join(', ')}`);
    this.name = 'ProcurementDeniedError';
    this.denialCodes = denialCodes;
  }
}

/**
 * Whether the run was mutated past FUNDED before failure. Kept for observability/logging — the
 * pipeline is checkpoint-resumable (see CheckpointStorePort), so the job handler no longer treats
 * this as a signal to skip retrying: a re-claimed job re-enters runOrchestratorPipeline, which
 * picks up from the run's persisted status and checkpointed artifacts instead of starting over.
 */
export class OrchestratorPipelineError extends Error {
  readonly advancedPastFunded: boolean;

  constructor(message: string, advancedPastFunded: boolean, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'OrchestratorPipelineError';
    this.advancedPastFunded = advancedPastFunded;
  }
}

export type PipelineResult = Readonly<{
  runId: string;
  finalStatus: RunStatus;
  attestationTransactionHash: `0x${string}`;
}>;

export async function runOrchestratorPipeline(
  runId: string,
  deps: OrchestratorPipelineDependencies,
): Promise<PipelineResult> {
  const now = deps.now ?? (() => new Date());
  const record = await deps.runRepository.findById(runId);
  if (!record) throw new Error(`Run not found: ${runId}`);
  if (!RESUMABLE_STATUSES.has(record.aggregate.status)) {
    throw new RunNotReadyForOrchestrationError(record.aggregate.status);
  }
  const quote = await deps.quoteRepository.findById(record.quoteId);
  if (!quote) throw new Error(`Quote not found for run ${runId}: ${record.quoteId}`);
  const targetVersionHash = quote.request.targetVersionHash as `0x${string}`;
  const policyHash = quote.request.policyHash as `0x${string}`;
  if (!record.customerPaymentProofHash || !record.customerPaymentAtomic) {
    throw new Error(`Run ${runId} is FUNDED but is missing its recorded customer payment`);
  }
  const customerPaymentProofHash = record.customerPaymentProofHash;
  const customerPaymentAtomic = record.customerPaymentAtomic;
  const quoteId = record.quoteId;
  const requestIdempotencyKey = record.requestIdempotencyKey;

  let current = record.aggregate;
  let advancedPastFunded = current.status !== 'FUNDED';
  const checkpoint = await deps.checkpointStore.load(runId);

  // Resuming: skip re-transitioning past whatever the run's persisted status already reflects.
  async function advance(actor: RunActor, to: RunStatus): Promise<void> {
    if (STATUS_ORDER.indexOf(current.status) >= STATUS_ORDER.indexOf(to)) return;
    const result = transitionRun(current, {
      actor,
      expectedRevision: current.revision,
      idempotencyKey: `orchestrator:${runId}:${to}`,
      occurredAt: now().toISOString(),
      to,
    });
    current = result.run;
    advancedPastFunded = true;
    if (!result.event) return;
    await deps.runRepository.save(
      { aggregate: result.run, quoteId, requestIdempotencyKey, uncommittedEvent: result.event },
      result.run.revision - 1,
    );
  }

  try {
    // ANALYZING
    await advance('ORCHESTRATOR', 'ANALYZING');
    let plan = checkpoint.plan as CompiledTestPlan | undefined;
    if (!plan) {
      const proposal = await deps.riskClassifier.classify({
        targetServiceId: quote.request.targetServiceId,
        targetVersionHash,
        x402Endpoint: quote.request.x402Endpoint,
        openApiUrl: quote.request.openApiUrl,
        serviceSummary: `Controlled demo x402 paid resource used to prove payment-proof replay handling for ${quote.request.targetServiceId}.`,
        mandatoryScenarios: deps.mandatoryScenarios,
        availableScenarios: Object.keys(SCENARIO_EXECUTORS),
        maximumToolBudgetAtomic: quote.refundableToolBudgetAtomic,
      });
      plan = compileTestPlan(proposal, deps.mandatoryScenarios, quote.refundableToolBudgetAtomic);
      await deps.checkpointStore.merge(runId, { plan });
    }

    // PLAN_COMPILED
    await advance('POLICY_ENGINE', 'PLAN_COMPILED');
    const deadlineEpochSeconds = Math.floor(now().getTime() / 1_000) + MANDATE_VALIDITY_SECONDS;
    const mandate = buildMandate(plan, { toolAgentId: deps.demoTarget.toolAgentId, host: deps.demoTarget.host }, deadlineEpochSeconds);

    // PROCURING
    await advance('PROCUREMENT_WORKER', 'PROCURING');
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
        runStatus: current.status,
        currentTotalSpend: '0',
        completedToolCalls: 0,
        priorAttemptsForTool: 0,
        shipyardAgentId: deps.shipyardAgentId,
        shipyardControlledHosts: [],
        additionalSpendApproved: false,
      };
      const authorization = authorizePurchase(mandate, intent, purchaseContext);
      if (!authorization.authorized) throw new ProcurementDeniedError(authorization.denialCodes);

      paymentTransactionHash = await deps.paymentSender.sendPayment({
        toAddress: deps.demoTarget.receivingAddress,
        valueWei: purchaseAmount,
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
        const refundTransactionHash = await deps.refundSender.sendRefund({
          tokenAddress: quote.capabilitySnapshot.tokenAddress as `0x${string}`,
          toAddress: quote.request.requesterAddress as `0x${string}`,
          valueAtomic: refundAmount,
        });
        await deps.checkpointStore.merge(runId, { refundTransactionHash });
      }
    }

    // EXECUTING
    await advance('PROCUREMENT_WORKER', 'EXECUTING');
    // Each scenario probe consumes something spend-once (the replay check spends the receipt;
    // future scenarios may spend other one-shot state) — re-running the whole batch on resume
    // would record false results, so the full set is checkpointed together like the payment above.
    let scenarioResults = checkpoint.evidence as readonly ScenarioResult[] | undefined;
    let startedAt = checkpoint.startedAt;
    let completedAt = checkpoint.completedAt;
    if (!scenarioResults || startedAt === undefined || completedAt === undefined) {
      startedAt = Math.floor(now().getTime() / 1_000);
      const context: ScenarioExecutionContext = {
        targetServiceId: quote.request.targetServiceId,
        targetVersionHash,
        policyHash,
        paymentReceipt: purchaseReceipt,
        paymentTransactionHash,
        deliveryClient: deps.deliveryClient,
      };
      const results: ScenarioResult[] = [];
      for (const scenarioId of plan.scenarios) {
        const executor = SCENARIO_EXECUTORS[scenarioId];
        if (!executor) continue;
        results.push(await executor(context));
      }
      if (results.length === 0) throw new Error('No scenario in the compiled plan has a registered executor');
      scenarioResults = results;
      completedAt = Math.floor(now().getTime() / 1_000);
      await deps.checkpointStore.merge(runId, { evidence: scenarioResults, startedAt, completedAt });
    }
    scenarioResults = verifyScenarioProvenance(scenarioResults, deps.demoTarget.providerSignerAddress);

    // EVIDENCE_BUILDING
    await advance('EXECUTION_WORKER', 'EVIDENCE_BUILDING');
    const toolReceipts = [];
    for (const scenarioResult of scenarioResults) {
      const unsignedReceipt = buildUnsignedToolReceipt(scenarioResult.evidence, {
        runId,
        toolAgentId: deps.demoTarget.toolAgentId,
        targetAgentId: quote.request.targetAgentId,
        targetVersionHash,
        policyHash,
        chainTransactionHash: scenarioResult.chainTransactionHash,
        chainId: deps.demoTarget.chainId,
        startedAt,
        completedAt,
        toolVersion: deps.demoTarget.toolVersion,
      });
      const signature = await deps.toolReceiptSigner.sign(unsignedReceipt);
      toolReceipts.push({ ...unsignedReceipt, signature });
    }
    const overallResult = aggregateScenarioResult(scenarioResults.map((result) => result.evidence));

    const evidencePack = buildEvidencePack({
      runId,
      targetServiceId: quote.request.targetServiceId,
      targetVersionHash,
      policyHash,
      riskLevel: plan.riskLevel,
      scenarios: scenarioResults.map((result) => result.evidence.scenarioId),
      result: overallResult,
      toolReceipts,
    });
    // Content-addressed and idempotent -- a resumed attempt republishing the same bytes gets the
    // same CID back, so this needs no checkpoint guard (unlike the payment and attestation sends).
    const evidenceURI = await deps.evidencePublisher.publish(canonicalEvidencePackContent(evidencePack.publicManifest));
    if (!(await deps.evidencePackStore.getByRunId(runId))) {
      await deps.evidencePackStore.put({
        runId,
        evidenceRoot: evidencePack.evidenceRoot,
        toolReceiptRoot: evidencePack.toolReceiptRoot,
        uri: evidenceURI,
        contentHash: evidencePack.contentHash,
        publicManifest: evidencePack.publicManifest,
        builtAt: now().toISOString(),
      });
    }

    // ATTESTING
    await advance('EVIDENCE_WORKER', 'ATTESTING');
    const attestationInput = buildAttestationInput({
      runId,
      targetAgentId: quote.request.targetAgentId,
      targetServiceId: quote.request.targetServiceId,
      targetVersionHash,
      policyHash,
      customerPaymentProofHash,
      toolReceiptRoot: evidencePack.toolReceiptRoot,
      evidenceRoot: evidencePack.evidenceRoot,
      evidenceURI,
      requester: quote.request.requesterAddress as `0x${string}`,
      shipyardAgent: deps.attestor.address,
      customerPaymentToken: quote.capabilitySnapshot.tokenAddress as `0x${string}`,
      toolSpendAtomic: purchaseAmount,
      customerPaymentAtomic: BigInt(customerPaymentAtomic),
      completedAt,
      result: overallResult,
    });
    // The registry is append-only and will revert a second attestation for the same run, so a
    // resumed attempt must reuse a checkpointed submission rather than resubmitting.
    let attestationTransactionHash = checkpoint.attestationTransactionHash;
    if (!attestationTransactionHash) {
      attestationTransactionHash = await deps.attestor.submit(attestationInput);
      await deps.checkpointStore.merge(runId, { attestationTransactionHash });
    }
    if (!(await deps.attestationStore.getByRunId(runId))) {
      await deps.attestationStore.put({
        runId,
        registryAddress: deps.attestor.registryAddress,
        chainId: deps.attestor.chainId,
        transactionHash: attestationTransactionHash,
        attestor: deps.attestor.address,
        expiresAt: new Date(attestationInput.expiresAt * 1_000).toISOString(),
        submittedAt: now().toISOString(),
      });
    }

    // DELIVERED_*
    const finalStatus: RunStatus = overallResult === 'PASS'
      ? 'DELIVERED_PASS'
      : overallResult === 'FAIL'
        ? 'DELIVERED_FAIL'
        : 'DELIVERED_INCONCLUSIVE';
    if (current.status !== finalStatus) {
      const result = transitionRun(current, {
        actor: 'ATTESTOR',
        expectedRevision: current.revision,
        idempotencyKey: `orchestrator:${runId}:${finalStatus}`,
        occurredAt: now().toISOString(),
        to: finalStatus,
      });
      current = result.run;
      if (result.event) {
        await deps.runRepository.save(
          { aggregate: result.run, quoteId, requestIdempotencyKey, uncommittedEvent: result.event },
          result.run.revision - 1,
        );
      }
    }

    return { runId, finalStatus, attestationTransactionHash };
  } catch (error) {
    if (error instanceof ProcurementDeniedError) throw error;
    throw new OrchestratorPipelineError(`Orchestrator pipeline failed for run ${runId}`, advancedPastFunded, { cause: error });
  }
}
