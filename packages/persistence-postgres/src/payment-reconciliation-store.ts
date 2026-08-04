import type {
  FundableRun,
  PaymentReconciliationStore,
} from '@shipyard402/payment-reconciliation';
import { quoteSchema, type Quote } from '@shipyard402/quote-engine';
import {
  RUN_RESULTS,
  RUN_STATUSES,
  type RunAggregate,
  type RunResult,
  type RunStatus,
} from '@shipyard402/run-domain';
import type { MerchantOrder } from '@shipyard402/x402-payments';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

import { PostgresFlowOrderContextStore } from './flow-order-context-store.js';

type FundableRow = QueryResultRow & {
  run_id: string;
  status: string;
  result: string | null;
  revision: string;
  created_at: Date | string;
  updated_at: Date | string;
  applied_keys: string[];
  customer_payment_proof_hash: Buffer | null;
  quote_id: string;
  request_snapshot: unknown;
  capability_snapshot: unknown;
  line_items: unknown;
  pricing_status: string;
  total_atomic_amount: string;
  refundable_tool_budget_atomic: string;
  quote_created_at: Date | string;
  quote_expires_at: Date | string;
  quote_commitment: Buffer;
  order_snapshot: unknown;
};

export class PostgresPaymentReconciliationStore implements PaymentReconciliationStore {
  readonly #pool: Pool;
  readonly #orderStore: PostgresFlowOrderContextStore;

  constructor(pool: Pool) {
    this.#pool = pool;
    this.#orderStore = new PostgresFlowOrderContextStore(pool);
  }

  async loadFundableRun(runId: string): Promise<FundableRun | null> {
    const result = await this.#pool.query<FundableRow>(
      `SELECT
        r.id AS run_id, r.status, r.result, r.revision::text, r.created_at, r.updated_at,
        r.customer_payment_proof_hash,
        ARRAY(SELECT e.idempotency_key FROM run_events e WHERE e.run_id = r.id ORDER BY e.revision) AS applied_keys,
        q.id AS quote_id, q.request_snapshot, q.capability_snapshot, q.line_items, q.pricing_status,
        q.total_atomic_amount::text, q.refundable_tool_budget_atomic::text,
        q.created_at AS quote_created_at, q.expires_at AS quote_expires_at, q.quote_commitment,
        po.order_snapshot
      FROM runs r
      JOIN quotes q ON q.id = r.quote_id
      JOIN payment_orders po ON po.run_id = r.id
      WHERE r.id = $1`,
      [runId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const context = await this.#orderStore.getByDappOrderId(row.run_id);
    if (!context) throw new Error('Payment order context disappeared during reconciliation load');

    return {
      run: parseRun(row),
      quote: parseQuote(row),
      paymentOrder: context.order,
      ...(row.customer_payment_proof_hash
        ? { customerPaymentProofHash: bufferToHex(row.customer_payment_proof_hash) }
        : {}),
    };
  }

  async commitFundedRun(input: Parameters<PaymentReconciliationStore['commitFundedRun']>[0]): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      await insertReceipt(client, input.payment);
      const updated = await client.query(
        `UPDATE runs SET
          status = 'FUNDED', revision = $2, customer_payment_atomic = $3,
          customer_payment_proof_hash = $4, updated_at = $5
        WHERE id = $1 AND revision = $6 AND status = 'PAYMENT_REQUIRED'`,
        [
          input.run.id,
          input.run.revision,
          input.payment.proof.atomicAmount,
          hexToBuffer(input.payment.proofHash),
          input.run.updatedAt,
          input.previousRevision,
        ],
      );
      if (updated.rowCount !== 1) throw new Error('Run revision conflict while committing customer payment');

      await client.query(
        `UPDATE payment_orders SET status = $2, order_snapshot = $3::jsonb, updated_at = $4 WHERE run_id = $1`,
        [input.run.id, input.payment.order.status, JSON.stringify(input.payment.order), input.payment.verifiedAt],
      );
      await client.query(
        `INSERT INTO run_events (run_id, revision, event_type, actor, idempotency_key, payload, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
        [
          input.event.runId, input.event.revision, input.event.type, input.event.actor,
          input.event.idempotencyKey, JSON.stringify(input.event), input.event.occurredAt,
        ],
      );
      await client.query(
        `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
         VALUES ('RUN', $1, $2, $3::jsonb)`,
        [input.run.id, input.event.type, JSON.stringify(input.event)],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

function parseRun(row: FundableRow): RunAggregate {
  const status = parseStatus(row.status);
  const result = row.result === null ? undefined : parseResult(row.result);
  return {
    id: row.run_id,
    status,
    ...(result === undefined ? {} : { result }),
    revision: Number(row.revision),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    appliedIdempotencyKeys: row.applied_keys,
  };
}

function parseQuote(row: FundableRow): Quote {
  return quoteSchema.parse({
    id: row.quote_id,
    request: row.request_snapshot,
    capabilitySnapshot: row.capability_snapshot,
    pricingStatus: row.pricing_status,
    lineItems: row.line_items,
    totalAtomicAmount: row.total_atomic_amount,
    refundableToolBudgetAtomic: row.refundable_tool_budget_atomic,
    createdAt: toIso(row.quote_created_at),
    expiresAt: toIso(row.quote_expires_at),
    quoteCommitment: bufferToHex(row.quote_commitment),
  });
}

async function insertReceipt(
  client: PoolClient,
  payment: Parameters<PaymentReconciliationStore['commitFundedRun']>[0]['payment'],
): Promise<void> {
  await client.query(
    `INSERT INTO payment_receipts (
      run_id, direction, order_id, chain_id, token, payer, recipient, atomic_amount,
      transaction_hash, log_index, proof_hash, provider_payload, verified_at
    ) VALUES ($1, 'CUSTOMER_IN', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)`,
    [
      payment.runId,
      payment.proof.orderId,
      payment.proof.chainId,
      hexToBuffer(payment.order.tokenAddress),
      hexToBuffer(payment.proof.fromAddress),
      hexToBuffer(payment.proof.toAddress),
      payment.proof.atomicAmount,
      hexToBuffer(payment.proof.transactionHash),
      payment.proof.logIndex,
      hexToBuffer(payment.proofHash),
      JSON.stringify({
        providerDigest: payment.proof.providerDigest ?? null,
        providerOrderStatus: payment.order.status,
        onChainReceiptStatus: payment.receipt.status,
      }),
      payment.verifiedAt,
    ],
  );
}

function parseStatus(value: string): RunStatus {
  if (!RUN_STATUSES.includes(value as RunStatus)) throw new Error(`Unknown run status in PostgreSQL: ${value}`);
  return value as RunStatus;
}

function parseResult(value: string): RunResult {
  if (!RUN_RESULTS.includes(value as RunResult)) throw new Error(`Unknown run result in PostgreSQL: ${value}`);
  return value as RunResult;
}

function toIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid PostgreSQL timestamp');
  return date.toISOString();
}

function hexToBuffer(value: string): Buffer {
  return Buffer.from(value.slice(2), 'hex');
}

function bufferToHex(value: Buffer): `0x${string}` {
  return `0x${value.toString('hex')}`;
}
