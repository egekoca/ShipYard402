import type { AttestationRecord, EvidencePack, OrchestratorRunCheckpoint } from '@shipyard402/persistence-postgres';
import { authorizePurchase, type PurchaseContext, type PurchaseIntent } from '@shipyard402/policy-engine';
import { ProtectedDeliveryReplayRunner, type ProtectedDeliveryClient, type ReplayEvidence, type ReplayScenario } from '@shipyard402/protected-delivery-runner';
import { compileTestPlan, type CompiledTestPlan, type RiskClassifier } from '@shipyard402/risk-classifier';
import { transitionRun, type RunActor, type RunStatus } from '@shipyard402/run-domain';
import { keccak256, toUtf8Bytes } from 'ethers';

import { buildAttestationInput } from './attestation-builder.js';
import { buildEvidencePack, buildUnsignedToolReceipt } from './evidence-builder.js';
import { buildMandate } from './mandate-builder.js';
import type {
  NativePaymentSender,
  PurchaseClient,
  QuoteRepositoryPort,
  RegistryAttestor,
  RunRepositoryPort,
  ToolReceiptSigner,
} from './ports.js';

const PAID_RESOURCE_ROUTE = '/paid/resource';
const MANDATE_VALIDITY_SECONDS = 900;

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
  purchaseClient: PurchaseClient;
  toolReceiptSigner: ToolReceiptSigner;
  evidencePackStore: EvidencePackStorePort;
  evidencePublicBaseUrl: string;
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

    // EXECUTING
    await advance('PROCUREMENT_WORKER', 'EXECUTING');
    // The replay probe itself spends the receipt (that is the point of the test) — re-running it
    // on resume would present an already-spent receipt and record a false replay-rejection, so
    // its result is checkpointed the same way as the payment above.
    let evidence = checkpoint.evidence as ReplayEvidence | undefined;
    let startedAt = checkpoint.startedAt;
    let completedAt = checkpoint.completedAt;
    if (!evidence || startedAt === undefined || completedAt === undefined) {
      startedAt = Math.floor(now().getTime() / 1_000);
      const scenario: ReplayScenario = {
        scenarioId: 'payment-proof-replay',
        targetServiceId: quote.request.targetServiceId,
        targetVersionHash,
        policyHash,
        method: 'GET',
        route: PAID_RESOURCE_ROUTE,
        paymentReceipt: purchaseReceipt,
        paymentProofHash: keccak256(toUtf8Bytes(paymentTransactionHash)) as `0x${string}`,
      };
      const runner = new ProtectedDeliveryReplayRunner(deps.deliveryClient);
      evidence = await runner.run(scenario);
      completedAt = Math.floor(now().getTime() / 1_000);
      await deps.checkpointStore.merge(runId, { evidence, startedAt, completedAt });
    }

    // EVIDENCE_BUILDING
    await advance('EXECUTION_WORKER', 'EVIDENCE_BUILDING');
    const unsignedReceipt = buildUnsignedToolReceipt(evidence, {
      runId,
      toolAgentId: deps.demoTarget.toolAgentId,
      targetAgentId: quote.request.targetAgentId,
      targetVersionHash,
      policyHash,
      chainTransactionHash: paymentTransactionHash,
      chainId: deps.demoTarget.chainId,
      startedAt,
      completedAt,
      toolVersion: deps.demoTarget.toolVersion,
    });
    const signature = await deps.toolReceiptSigner.sign(unsignedReceipt);
    const toolReceipt = { ...unsignedReceipt, signature };

    const evidencePack = buildEvidencePack({
      runId,
      targetServiceId: quote.request.targetServiceId,
      targetVersionHash,
      policyHash,
      riskLevel: plan.riskLevel,
      scenarios: plan.scenarios,
      result: evidence.result,
      toolReceipts: [toolReceipt],
    });
    const evidenceURI = new URL(`/v1/runs/${runId}/evidence`, deps.evidencePublicBaseUrl).toString();
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
      result: evidence.result,
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
    const finalStatus: RunStatus = evidence.result === 'PASS'
      ? 'DELIVERED_PASS'
      : evidence.result === 'FAIL'
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
