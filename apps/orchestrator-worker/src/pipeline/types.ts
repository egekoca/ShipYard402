import type {
  AttestationRecord,
  EvidencePack,
  OrchestratorRunCheckpoint,
  RunSettlementLeg,
} from '@shipyard402/persistence-postgres';
import type { ProtectedDeliveryClient, ReplayEvidence } from '@shipyard402/protected-delivery-runner';
import type { RiskClassifier } from '@shipyard402/risk-classifier';
import type { RunStatus } from '@shipyard402/run-domain';
import type { CrossChainBridgePort, EvmAsset } from '@shipyard402/x402-payments';
import type { BnbX402PaymentClient } from '@shipyard402/bnb-x402-client';

import type { EvidencePublisherPort } from '../ipfs-publisher.js';
import type {
  QuoteRepositoryPort,
  RefundSender,
  RegistryAttestor,
  RunRepositoryPort,
  ToolReceiptSigner,
  X402PayerPort,
} from '../ports.js';

export type ScenarioExecutionContext = Readonly<{
  targetServiceId: string;
  targetVersionHash: `0x${string}`;
  policyHash: `0x${string}`;
  /** The x402 `X-PAYMENT` header the scenarios present (and, for replay, re-present). */
  paymentReceipt: string;
  paymentHeaderName: 'x-payment' | 'payment-signature';
  /** The payment's on-chain identity (the EIP-3009 authorization nonce). */
  paymentTransactionHash: `0x${string}`;
  /** The paid resource path on the target, derived from the run's own x402 endpoint. */
  route: string;
  deliveryClient: ProtectedDeliveryClient;
}>;

export type ScenarioResult = Readonly<{ evidence: ReplayEvidence; chainTransactionHash: `0x${string}` }>;

/** One chain this worker can buy a paid resource on, and how it pays there. */
export type CrossChainPayerRegistration = Readonly<{
  chainId: number;
  mode: 'BRIDGE_THEN_PAY' | 'PREFUNDED';
  /** What one purchase draws from the run's tool budget, in the funding rail's units. */
  policyCostAtomic: string;
  /** Ceiling for one target payment, in the settlement asset's units. */
  targetPaymentAmountAtomic: string;
  settlementAsset: EvmAsset;
  destinationPayerAddress: `0x${string}`;
  /** Pins the recipient. Absent means it comes from the target's own 402 challenge. */
  targetPayToAddress?: `0x${string}`;
  /** Builds a payer bound to one run's target endpoint, chosen from the directory. */
  payerFor: (endpoint: string) => BnbX402PaymentClient;
  /** Present only in BRIDGE_THEN_PAY. */
  bridge?: Readonly<{
    port: CrossChainBridgePort;
    provider: string;
    fundingAsset: EvmAsset;
    sourceBridgeAmountAtomic: string;
    sourceBridgePayerAddress: `0x${string}`;
    maximumBridgeWaitSeconds: number;
  }>;
}>;

export interface EvidencePackStorePort {
  put(pack: EvidencePack): Promise<void>;
  getByRunId(runId: string): Promise<EvidencePack | null>;
}

export interface AttestationStorePort {
  put(record: AttestationRecord): Promise<void>;
  getByRunId(runId: string): Promise<AttestationRecord | null>;
}

/**
 * Records what a run's money actually did, step by step, for anything that reads a run's progress
 * without knowing which procurement shape produced it. Purely observational: nothing in the
 * pipeline branches on a leg, so a failure to write one can never change what gets paid.
 */
export interface SettlementLegPort {
  record(leg: RunSettlementLeg): Promise<void>;
}

export interface CheckpointStorePort {
  load(runId: string): Promise<OrchestratorRunCheckpoint>;
  /** Returns the row as it actually persisted -- see PostgresOrchestratorCheckpointStore's doc
   * comment. A caller gating a spend-once side effect on a merged field must use the returned
   * value, not its own local variable, or a losing writer in a race acts on a value nobody kept. */
  merge(runId: string, patch: OrchestratorRunCheckpoint): Promise<OrchestratorRunCheckpoint>;
}

/**
 * What the worker still needs to know about the provider it receipts. The endpoint, host, price and
 * recipient used to live here too; they are per-run now (the target is whichever service the
 * customer selected), so they arrive on the quote instead of the worker's own configuration.
 */
export type DemoTargetConfig = Readonly<{
  toolAgentId: string;
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
  /**
   * Builds a delivery client bound to one target's origin. Per-run rather than a single shared
   * client because the target now varies per run (whatever service the customer selected), so the
   * scenarios must be presented to that run's own endpoint, not one fixed base URL.
   */
  deliveryClientFor: (endpoint: string) => ProtectedDeliveryClient;
  x402Payer: X402PayerPort;
  /**
   * The settlement assets this worker will pay a target in. The target writes its own 402
   * challenge, so without an operator-fixed allowlist the asset (and the EIP-712 domain signed
   * with it) is chosen by whoever the customer pointed us at.
   */
  procurementAllowedAssets: readonly `0x${string}`[];
  /** The chain this worker itself funds and attests on. Any target elsewhere needs a payer below. */
  homeChainId: number;
  /**
   * The chains this worker can settle a target payment on, one registration each.
   *
   * A registry rather than a single configured endpoint: the target is whatever service the
   * customer picked from the directory, so the endpoint is only knowable per run. `payerFor` binds
   * a payer to that run's endpoint; everything else -- which asset, which ceiling, whether funds
   * are bridged or already held -- is fixed per chain in advance.
   *
   * A run whose target sits on a chain with no registration is refused rather than paid on the
   * home chain, which would sign an authorization the target can never settle.
   */
  crossChainPayers?: readonly CrossChainPayerRegistration[];
  /**
   * Undefined until real customer funds exist to refund from -- GOAT Flow merchant onboarding is
   * still simulated (see docs/business-model.md), so there is nothing to send back yet. Wiring
   * this in is what activates the refund step below; leaving it unset is a deliberate no-op, not
   * a silent failure.
   */
  refundSender?: RefundSender;
  toolReceiptSigner: ToolReceiptSigner;
  evidencePackStore: EvidencePackStorePort;
  evidencePublisher: EvidencePublisherPort;
  attestor: RegistryAttestor;
  attestationStore: AttestationStorePort;
  checkpointStore: CheckpointStorePort;
  /** Optional: when absent, procurement simply records no legs and everything else is unchanged. */
  settlementLegs?: SettlementLegPort;
  now?: () => Date;
}>;

export type PipelineResult = Readonly<{
  runId: string;
  finalStatus: RunStatus;
  attestationTransactionHash: `0x${string}`;
}>;
