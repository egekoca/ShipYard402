import type { Quote } from '@shipyard402/quote-engine';
import type { RunAggregate, RunTransitionedEvent } from '@shipyard402/run-domain';
import type { UnsignedToolReceipt } from '@shipyard402/evidence-sdk';
import type { AcquiredPayment } from '@shipyard402/x402-payments';

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

/**
 * The buyer side of x402 procurement: negotiate the run's target's 402 challenge and produce a
 * signed `X-PAYMENT` for exactly what it asks. Replaces the old "send a native transfer, then claim
 * a receipt" flow -- the signed authorization *is* the payment, and the target settles it on-chain
 * (consuming the nonce) when it first delivers.
 */
export interface X402PayerPort {
  readonly payerAddress: `0x${string}`;
  acquire(
    input: Readonly<{
      endpoint: string;
      /** 32-byte hex; owned by the caller so the payment is a checkpointable, spend-once artifact. */
      nonce: `0x${string}`;
      validAfterSec: number;
      validBeforeSec: number;
      maxAmountAtomic: string;
      expectedChainId: number;
      /** The assets this worker is willing to sign an authorization for; see AcquirePaymentInput. */
      allowedAssets: readonly `0x${string}`[];
    }>,
  ): Promise<AcquiredPayment>;
}

export interface ToolReceiptSigner {
  readonly address: `0x${string}`;
  sign(receipt: UnsignedToolReceipt): Promise<`0x${string}`>;
}

export interface RefundSender {
  reserveNonce(): Promise<number>;
  isNonceConsumed(nonce: number): Promise<boolean>;
  sendRefund(
    input: Readonly<{ tokenAddress: `0x${string}`; toAddress: `0x${string}`; valueAtomic: bigint; nonce: number }>,
  ): Promise<`0x${string}`>;
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
