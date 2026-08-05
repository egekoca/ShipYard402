import type { Quote } from '@shipyard402/quote-engine';
import type { RunAggregate, RunTransitionedEvent } from '@shipyard402/run-domain';
import type { UnsignedToolReceipt } from '@shipyard402/evidence-sdk';

export type RunRecord = Readonly<{
  aggregate: RunAggregate;
  quoteId: string;
  requestIdempotencyKey: string;
  customerPaymentProofHash?: `0x${string}`;
  customerPaymentAtomic?: string;
}>;

export interface RunRepositoryPort {
  findById(id: string): Promise<RunRecord | null>;
  save(
    record: Readonly<{
      aggregate: RunAggregate;
      quoteId: string;
      requestIdempotencyKey: string;
      uncommittedEvent: RunTransitionedEvent;
    }>,
    expectedPersistedRevision: number,
  ): Promise<void>;
}

export interface QuoteRepositoryPort {
  findById(id: string): Promise<Quote | null>;
}

export type ConfirmedPayment = Readonly<{
  transactionHash: `0x${string}`;
  confirmations: number;
}>;

export interface PurchaseClient {
  purchase(transactionHash: `0x${string}`): Promise<Readonly<{ receipt: string }>>;
}

export interface NativePaymentSender {
  sendPayment(input: Readonly<{ toAddress: `0x${string}`; valueWei: bigint }>): Promise<`0x${string}`>;
  waitForConfirmation(transactionHash: `0x${string}`, minimumConfirmations: number): Promise<ConfirmedPayment>;
}

export interface ToolReceiptSigner {
  readonly address: `0x${string}`;
  sign(receipt: UnsignedToolReceipt): Promise<`0x${string}`>;
}

export interface RefundSender {
  sendRefund(input: Readonly<{ tokenAddress: `0x${string}`; toAddress: `0x${string}`; valueAtomic: bigint }>): Promise<`0x${string}`>;
}

export type RunAttestationInput = Readonly<{
  runId: `0x${string}`;
  targetAgentId: bigint;
  targetServiceId: `0x${string}`;
  targetVersionHash: `0x${string}`;
  policyHash: `0x${string}`;
  customerPaymentProofHash: `0x${string}`;
  toolReceiptRoot: `0x${string}`;
  evidenceRoot: `0x${string}`;
  evidenceURI: string;
  requester: `0x${string}`;
  shipyardAgent: `0x${string}`;
  customerPaymentToken: `0x${string}`;
  toolSpendToken: `0x${string}`;
  customerPayment: bigint;
  toolSpend: bigint;
  completedAt: number;
  expiresAt: number;
  result: 'PASS' | 'CONDITIONAL' | 'FAIL' | 'INCONCLUSIVE';
}>;

export interface RegistryAttestor {
  readonly address: `0x${string}`;
  readonly registryAddress: `0x${string}`;
  readonly chainId: number;
  submit(attestation: RunAttestationInput): Promise<`0x${string}`>;
}
