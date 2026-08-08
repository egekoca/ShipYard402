import type { AttestationRecord, EvidencePack, OrchestratorRunCheckpoint } from '@shipyard402/persistence-postgres';
import type { ProtectedDeliveryClient, ReplayEvidence } from '@shipyard402/protected-delivery-runner';
import type { RiskClassifier } from '@shipyard402/risk-classifier';
import type { RunStatus } from '@shipyard402/run-domain';

import type { EvidencePublisherPort } from '../ipfs-publisher.js';
import type {
  NativePaymentSender,
  PurchaseClient,
  QuoteRepositoryPort,
  RefundSender,
  RegistryAttestor,
  RunRepositoryPort,
  ToolReceiptSigner,
} from '../ports.js';

export type ScenarioExecutionContext = Readonly<{
  targetServiceId: string;
  targetVersionHash: `0x${string}`;
  policyHash: `0x${string}`;
  paymentReceipt: string;
  paymentTransactionHash: `0x${string}`;
  deliveryClient: ProtectedDeliveryClient;
}>;

export type ScenarioResult = Readonly<{ evidence: ReplayEvidence; chainTransactionHash: `0x${string}` }>;

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
  /** Returns the row as it actually persisted -- see PostgresOrchestratorCheckpointStore's doc
   * comment. A caller gating a spend-once side effect on a merged field must use the returned
   * value, not its own local variable, or a losing writer in a race acts on a value nobody kept. */
  merge(runId: string, patch: OrchestratorRunCheckpoint): Promise<OrchestratorRunCheckpoint>;
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

export type PipelineResult = Readonly<{
  runId: string;
  finalStatus: RunStatus;
  attestationTransactionHash: `0x${string}`;
}>;
