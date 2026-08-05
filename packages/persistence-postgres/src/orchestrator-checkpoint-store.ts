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
  paymentTransactionHash?: `0x${string}`;
  purchaseReceipt?: string;
  evidence?: unknown;
  startedAt?: number;
  completedAt?: number;
  attestationTransactionHash?: `0x${string}`;
  refundTransactionHash?: `0x${string}`;
}>;

export interface OrchestratorCheckpointStore {
  load(runId: string): Promise<OrchestratorRunCheckpoint>;
  merge(runId: string, patch: OrchestratorRunCheckpoint): Promise<void>;
}

type CheckpointRow = QueryResultRow & {
  risk_level: string | null;
  scenarios: unknown;
  tool_budget_atomic: string | null;
  rationale: string | null;
  ai_proposal: unknown;
  payment_transaction_hash: Buffer | null;
  purchase_receipt: string | null;
  evidence: unknown;
  started_at: string | null;
  completed_at: string | null;
  attestation_transaction_hash: Buffer | null;
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
      `SELECT risk_level, scenarios, tool_budget_atomic, rationale, ai_proposal, payment_transaction_hash,
              purchase_receipt, evidence, started_at, completed_at, attestation_transaction_hash,
              refund_transaction_hash
       FROM orchestrator_run_checkpoints WHERE run_id = $1`,
      [runId],
    );
    const row = result.rows[0];
    return row ? parseRow(row) : EMPTY_CHECKPOINT;
  }

  async merge(runId: string, patch: OrchestratorRunCheckpoint): Promise<void> {
    await this.#pool.query(
      `INSERT INTO orchestrator_run_checkpoints (
         run_id, risk_level, scenarios, tool_budget_atomic, rationale, ai_proposal,
         payment_transaction_hash, purchase_receipt, evidence, started_at, completed_at,
         attestation_transaction_hash, refund_transaction_hash
       ) VALUES ($1, $2, $3::jsonb, $4, $5, $6::jsonb, $7, $8, $9::jsonb, $10, $11, $12, $13)
       ON CONFLICT (run_id) DO UPDATE SET
         risk_level = COALESCE(orchestrator_run_checkpoints.risk_level, EXCLUDED.risk_level),
         scenarios = COALESCE(orchestrator_run_checkpoints.scenarios, EXCLUDED.scenarios),
         tool_budget_atomic = COALESCE(orchestrator_run_checkpoints.tool_budget_atomic, EXCLUDED.tool_budget_atomic),
         rationale = COALESCE(orchestrator_run_checkpoints.rationale, EXCLUDED.rationale),
         ai_proposal = COALESCE(orchestrator_run_checkpoints.ai_proposal, EXCLUDED.ai_proposal),
         payment_transaction_hash = COALESCE(orchestrator_run_checkpoints.payment_transaction_hash, EXCLUDED.payment_transaction_hash),
         purchase_receipt = COALESCE(orchestrator_run_checkpoints.purchase_receipt, EXCLUDED.purchase_receipt),
         evidence = COALESCE(orchestrator_run_checkpoints.evidence, EXCLUDED.evidence),
         started_at = COALESCE(orchestrator_run_checkpoints.started_at, EXCLUDED.started_at),
         completed_at = COALESCE(orchestrator_run_checkpoints.completed_at, EXCLUDED.completed_at),
         attestation_transaction_hash = COALESCE(orchestrator_run_checkpoints.attestation_transaction_hash, EXCLUDED.attestation_transaction_hash),
         refund_transaction_hash = COALESCE(orchestrator_run_checkpoints.refund_transaction_hash, EXCLUDED.refund_transaction_hash),
         updated_at = now()`,
      [
        runId,
        patch.plan?.riskLevel ?? null,
        patch.plan ? JSON.stringify(patch.plan.scenarios) : null,
        patch.plan?.toolBudgetAtomic ?? null,
        patch.plan?.rationale ?? null,
        patch.proposal !== undefined ? JSON.stringify(patch.proposal) : null,
        patch.paymentTransactionHash ? hexToBuffer(patch.paymentTransactionHash) : null,
        patch.purchaseReceipt ?? null,
        patch.evidence !== undefined ? JSON.stringify(patch.evidence) : null,
        patch.startedAt ?? null,
        patch.completedAt ?? null,
        patch.attestationTransactionHash ? hexToBuffer(patch.attestationTransactionHash) : null,
        patch.refundTransactionHash ? hexToBuffer(patch.refundTransactionHash) : null,
      ],
    );
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
    ...(row.payment_transaction_hash ? { paymentTransactionHash: bufferToHex(row.payment_transaction_hash) } : {}),
    ...(row.purchase_receipt ? { purchaseReceipt: row.purchase_receipt } : {}),
    ...(row.evidence !== null && row.evidence !== undefined ? { evidence: row.evidence } : {}),
    ...(row.started_at !== null ? { startedAt: Number(row.started_at) } : {}),
    ...(row.completed_at !== null ? { completedAt: Number(row.completed_at) } : {}),
    ...(row.attestation_transaction_hash ? { attestationTransactionHash: bufferToHex(row.attestation_transaction_hash) } : {}),
    ...(row.refund_transaction_hash ? { refundTransactionHash: bufferToHex(row.refund_transaction_hash) } : {}),
  };
}

function hexToBuffer(value: string): Buffer {
  return Buffer.from(value.slice(2), 'hex');
}

function bufferToHex(value: Buffer): `0x${string}` {
  return `0x${value.toString('hex')}`;
}
