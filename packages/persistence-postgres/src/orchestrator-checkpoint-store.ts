import type { Pool, QueryResultRow } from 'pg';

export type OrchestratorRunCheckpoint = Readonly<{
  plan?: Readonly<{
    riskLevel: string;
    scenarios: readonly string[];
    toolBudgetAtomic: string;
    rationale: string;
  }>;
  /**
   * The AI's raw, pre-compilation proposal -- kept only for transparency (surfaced in evidence
   * pack manifests), never re-read as an input to pipeline logic. `plan` above is the sole
   * authority for what actually runs.
   */
  proposal?: unknown;
  /**
   * Reserved before the corresponding send is broadcast, so a crash between broadcast and
   * checkpointing the resulting hash can be detected on resume (the reserved nonce will already
   * be consumed on-chain) instead of blindly resending and risking a double payment.
   */
  paymentNonce?: number;
  paymentTransactionHash?: `0x${string}`;
  purchaseReceipt?: string;
  paymentHeaderName?: 'x-payment' | 'payment-signature';
  bridgeProvider?: string;
  bridgeTransferId?: string;
  bridgeSourceTransactionHash?: `0x${string}`;
  bridgeSubmittedAt?: number;
  bridgeDestinationTransactionHash?: `0x${string}`;
  bridgeAmountReceivedAtomic?: string;
  targetPaymentTransactionHash?: `0x${string}`;
  targetPaymentAmountAtomic?: string;
  evidence?: unknown;
  startedAt?: number;
  completedAt?: number;
  attestationTransactionHash?: `0x${string}`;
  refundNonce?: number;
  refundTransactionHash?: `0x${string}`;
}>;

export interface OrchestratorCheckpointStore {
  load(runId: string): Promise<OrchestratorRunCheckpoint>;
  /**
   * Returns the row as it actually ended up after the upsert, not the caller's patch -- on a
   * race between two writers, COALESCE keeps whichever value landed first, and the loser has no
   * way to know its own value didn't stick without reading this back. Callers gating a spend-once
   * side effect on a merged field (e.g. paymentNonce) must use the returned value, not their own
   * local variable, or a losing writer can go on to act on a nonce nobody actually persisted.
   */
  merge(runId: string, patch: OrchestratorRunCheckpoint): Promise<OrchestratorRunCheckpoint>;
}

type CheckpointRow = QueryResultRow & {
  risk_level: string | null;
  scenarios: unknown;
  tool_budget_atomic: string | null;
  rationale: string | null;
  ai_proposal: unknown;
  payment_nonce: number | null;
  payment_transaction_hash: Buffer | null;
  purchase_receipt: string | null;
  payment_header_name: 'x-payment' | 'payment-signature' | null;
  bridge_provider: string | null;
  bridge_transfer_id: string | null;
  bridge_source_transaction_hash: Buffer | null;
  bridge_submitted_at: string | null;
  bridge_destination_transaction_hash: Buffer | null;
  bridge_amount_received_atomic: string | null;
  target_payment_transaction_hash: Buffer | null;
  target_payment_amount_atomic: string | null;
  evidence: unknown;
  started_at: string | null;
  completed_at: string | null;
  attestation_transaction_hash: Buffer | null;
  refund_nonce: number | null;
  refund_transaction_hash: Buffer | null;
};

const EMPTY_CHECKPOINT: OrchestratorRunCheckpoint = {};

export class PostgresOrchestratorCheckpointStore implements OrchestratorCheckpointStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async load(runId: string): Promise<OrchestratorRunCheckpoint> {
    const result = await this.#pool.query<CheckpointRow>(
      `SELECT risk_level, scenarios, tool_budget_atomic, rationale, ai_proposal, payment_nonce,
              payment_transaction_hash, purchase_receipt, payment_header_name, bridge_provider,
              bridge_transfer_id, bridge_source_transaction_hash, bridge_submitted_at,
              bridge_destination_transaction_hash,
              bridge_amount_received_atomic::text, target_payment_transaction_hash,
              target_payment_amount_atomic::text, evidence, started_at, completed_at,
              attestation_transaction_hash, refund_nonce, refund_transaction_hash
       FROM orchestrator_run_checkpoints WHERE run_id = $1`,
      [runId],
    );
    const row = result.rows[0];
    return row ? parseRow(row) : EMPTY_CHECKPOINT;
  }

  async merge(runId: string, patch: OrchestratorRunCheckpoint): Promise<OrchestratorRunCheckpoint> {
    const result = await this.#pool.query<CheckpointRow>(
      `INSERT INTO orchestrator_run_checkpoints (
         run_id, risk_level, scenarios, tool_budget_atomic, rationale, ai_proposal,
         payment_nonce, payment_transaction_hash, purchase_receipt, payment_header_name, bridge_provider,
         bridge_transfer_id, bridge_source_transaction_hash, bridge_submitted_at,
         bridge_destination_transaction_hash,
         bridge_amount_received_atomic, target_payment_transaction_hash, target_payment_amount_atomic,
         evidence, started_at, completed_at,
         attestation_transaction_hash, refund_nonce, refund_transaction_hash
       ) VALUES (
         $1, $2, $3::jsonb, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14,
         $15, $16, $17, $18, $19::jsonb, $20, $21, $22, $23, $24
       )
       ON CONFLICT (run_id) DO UPDATE SET
         risk_level = COALESCE(orchestrator_run_checkpoints.risk_level, EXCLUDED.risk_level),
         scenarios = COALESCE(orchestrator_run_checkpoints.scenarios, EXCLUDED.scenarios),
         tool_budget_atomic = COALESCE(orchestrator_run_checkpoints.tool_budget_atomic, EXCLUDED.tool_budget_atomic),
         rationale = COALESCE(orchestrator_run_checkpoints.rationale, EXCLUDED.rationale),
         ai_proposal = COALESCE(orchestrator_run_checkpoints.ai_proposal, EXCLUDED.ai_proposal),
         payment_nonce = COALESCE(orchestrator_run_checkpoints.payment_nonce, EXCLUDED.payment_nonce),
         payment_transaction_hash = COALESCE(orchestrator_run_checkpoints.payment_transaction_hash, EXCLUDED.payment_transaction_hash),
         purchase_receipt = COALESCE(orchestrator_run_checkpoints.purchase_receipt, EXCLUDED.purchase_receipt),
         payment_header_name = COALESCE(orchestrator_run_checkpoints.payment_header_name, EXCLUDED.payment_header_name),
         bridge_provider = COALESCE(orchestrator_run_checkpoints.bridge_provider, EXCLUDED.bridge_provider),
         bridge_transfer_id = COALESCE(orchestrator_run_checkpoints.bridge_transfer_id, EXCLUDED.bridge_transfer_id),
         bridge_source_transaction_hash = COALESCE(orchestrator_run_checkpoints.bridge_source_transaction_hash, EXCLUDED.bridge_source_transaction_hash),
         bridge_submitted_at = COALESCE(orchestrator_run_checkpoints.bridge_submitted_at, EXCLUDED.bridge_submitted_at),
         bridge_destination_transaction_hash = COALESCE(orchestrator_run_checkpoints.bridge_destination_transaction_hash, EXCLUDED.bridge_destination_transaction_hash),
         bridge_amount_received_atomic = COALESCE(orchestrator_run_checkpoints.bridge_amount_received_atomic, EXCLUDED.bridge_amount_received_atomic),
         target_payment_transaction_hash = COALESCE(orchestrator_run_checkpoints.target_payment_transaction_hash, EXCLUDED.target_payment_transaction_hash),
         target_payment_amount_atomic = COALESCE(orchestrator_run_checkpoints.target_payment_amount_atomic, EXCLUDED.target_payment_amount_atomic),
         evidence = COALESCE(orchestrator_run_checkpoints.evidence, EXCLUDED.evidence),
         started_at = COALESCE(orchestrator_run_checkpoints.started_at, EXCLUDED.started_at),
         completed_at = COALESCE(orchestrator_run_checkpoints.completed_at, EXCLUDED.completed_at),
         attestation_transaction_hash = COALESCE(orchestrator_run_checkpoints.attestation_transaction_hash, EXCLUDED.attestation_transaction_hash),
         refund_nonce = COALESCE(orchestrator_run_checkpoints.refund_nonce, EXCLUDED.refund_nonce),
         refund_transaction_hash = COALESCE(orchestrator_run_checkpoints.refund_transaction_hash, EXCLUDED.refund_transaction_hash),
         updated_at = now()
       RETURNING risk_level, scenarios, tool_budget_atomic, rationale, ai_proposal, payment_nonce,
                 payment_transaction_hash, purchase_receipt, payment_header_name, bridge_provider,
                 bridge_transfer_id, bridge_source_transaction_hash, bridge_submitted_at,
                 bridge_destination_transaction_hash,
                 bridge_amount_received_atomic::text, target_payment_transaction_hash,
                 target_payment_amount_atomic::text, evidence, started_at, completed_at,
                 attestation_transaction_hash, refund_nonce, refund_transaction_hash`,
      [
        runId,
        patch.plan?.riskLevel ?? null,
        patch.plan ? JSON.stringify(patch.plan.scenarios) : null,
        patch.plan?.toolBudgetAtomic ?? null,
        patch.plan?.rationale ?? null,
        patch.proposal !== undefined ? JSON.stringify(patch.proposal) : null,
        patch.paymentNonce ?? null,
        patch.paymentTransactionHash ? hexToBuffer(patch.paymentTransactionHash) : null,
        patch.purchaseReceipt ?? null,
        patch.paymentHeaderName ?? null,
        patch.bridgeProvider ?? null,
        patch.bridgeTransferId ?? null,
        patch.bridgeSourceTransactionHash ? hexToBuffer(patch.bridgeSourceTransactionHash) : null,
        patch.bridgeSubmittedAt ?? null,
        patch.bridgeDestinationTransactionHash ? hexToBuffer(patch.bridgeDestinationTransactionHash) : null,
        patch.bridgeAmountReceivedAtomic ?? null,
        patch.targetPaymentTransactionHash ? hexToBuffer(patch.targetPaymentTransactionHash) : null,
        patch.targetPaymentAmountAtomic ?? null,
        patch.evidence !== undefined ? JSON.stringify(patch.evidence) : null,
        patch.startedAt ?? null,
        patch.completedAt ?? null,
        patch.attestationTransactionHash ? hexToBuffer(patch.attestationTransactionHash) : null,
        patch.refundNonce ?? null,
        patch.refundTransactionHash ? hexToBuffer(patch.refundTransactionHash) : null,
      ],
    );
    return parseRow(result.rows[0]!);
  }
}

function parseRow(row: CheckpointRow): OrchestratorRunCheckpoint {
  return {
    ...(row.risk_level && row.scenarios !== null && row.tool_budget_atomic !== null && row.rationale
      ? {
          plan: {
            riskLevel: row.risk_level,
            scenarios: row.scenarios as readonly string[],
            toolBudgetAtomic: row.tool_budget_atomic,
            rationale: row.rationale,
          },
        }
      : {}),
    ...(row.ai_proposal !== null && row.ai_proposal !== undefined ? { proposal: row.ai_proposal } : {}),
    ...(row.payment_nonce !== null ? { paymentNonce: row.payment_nonce } : {}),
    ...(row.payment_transaction_hash ? { paymentTransactionHash: bufferToHex(row.payment_transaction_hash) } : {}),
    ...(row.purchase_receipt ? { purchaseReceipt: row.purchase_receipt } : {}),
    ...(row.payment_header_name ? { paymentHeaderName: row.payment_header_name } : {}),
    ...(row.bridge_provider ? { bridgeProvider: row.bridge_provider } : {}),
    ...(row.bridge_transfer_id ? { bridgeTransferId: row.bridge_transfer_id } : {}),
    ...(row.bridge_source_transaction_hash
      ? { bridgeSourceTransactionHash: bufferToHex(row.bridge_source_transaction_hash) }
      : {}),
    ...(row.bridge_submitted_at !== null ? { bridgeSubmittedAt: Number(row.bridge_submitted_at) } : {}),
    ...(row.bridge_destination_transaction_hash
      ? { bridgeDestinationTransactionHash: bufferToHex(row.bridge_destination_transaction_hash) }
      : {}),
    ...(row.bridge_amount_received_atomic !== null
      ? { bridgeAmountReceivedAtomic: row.bridge_amount_received_atomic }
      : {}),
    ...(row.target_payment_transaction_hash
      ? { targetPaymentTransactionHash: bufferToHex(row.target_payment_transaction_hash) }
      : {}),
    ...(row.target_payment_amount_atomic !== null
      ? { targetPaymentAmountAtomic: row.target_payment_amount_atomic }
      : {}),
    ...(row.evidence !== null && row.evidence !== undefined ? { evidence: row.evidence } : {}),
    ...(row.started_at !== null ? { startedAt: Number(row.started_at) } : {}),
    ...(row.completed_at !== null ? { completedAt: Number(row.completed_at) } : {}),
    ...(row.attestation_transaction_hash
      ? { attestationTransactionHash: bufferToHex(row.attestation_transaction_hash) }
      : {}),
    ...(row.refund_nonce !== null ? { refundNonce: row.refund_nonce } : {}),
    ...(row.refund_transaction_hash ? { refundTransactionHash: bufferToHex(row.refund_transaction_hash) } : {}),
  };
}

function hexToBuffer(value: string): Buffer {
  return Buffer.from(value.slice(2), 'hex');
}

function bufferToHex(value: Buffer): `0x${string}` {
  return `0x${value.toString('hex')}`;
}
