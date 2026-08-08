import type {
  FundableRun,
  PaymentReconciliationStore,
  VerifiedCustomerPayment,
} from '@shipyard402/payment-reconciliation';
import { quoteSchema, type Quote } from '@shipyard402/quote-engine';
import { RUN_RESULTS, RUN_STATUSES, type RunAggregate, type RunResult, type RunStatus } from '@shipyard402/run-domain';
import type { MerchantOrder, MerchantPaymentProof, NormalizedTransactionReceipt } from '@shipyard402/x402-payments';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { z } from 'zod';

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
  receipt_order_id: string | null;
  receipt_chain_id: string | null;
  receipt_payer: Buffer | null;
  receipt_recipient: Buffer | null;
  receipt_atomic_amount: string | null;
  receipt_transaction_hash: Buffer | null;
  receipt_log_index: number | null;
  receipt_proof_hash: Buffer | null;
  receipt_provider_payload: unknown;
  receipt_verified_at: Date | string | null;
};

const persistedPaymentPayloadSchema = z
  .object({
    proof: z
      .object({
        orderId: z.string().min(1),
        transactionHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
        logIndex: z.number().int().nonnegative(),
        fromAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
        toAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
        atomicAmount: z.string().regex(/^(0|[1-9]\d*)$/),
        chainId: z.number().int().positive(),
        providerDigest: z
          .string()
          .regex(/^0x[a-fA-F0-9]{64}$/)
          .optional(),
      })
      .strict(),
    receipt: z
      .object({
        chainId: z.number().int().positive(),
        transactionHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
        status: z.union([z.literal(0), z.literal(1)]),
        logs: z.array(
          z
            .object({
              address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
              topics: z.array(z.string().regex(/^0x[a-fA-F0-9]*$/)),
              data: z.string().regex(/^0x[a-fA-F0-9]*$/),
              index: z.number().int().nonnegative(),
            })
            .strict(),
        ),
      })
      .strict(),
  })
  .passthrough();

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
        po.order_snapshot,
        pr.order_id AS receipt_order_id, pr.chain_id::text AS receipt_chain_id,
        pr.payer AS receipt_payer, pr.recipient AS receipt_recipient,
        pr.atomic_amount::text AS receipt_atomic_amount,
        pr.transaction_hash AS receipt_transaction_hash, pr.log_index AS receipt_log_index,
        pr.proof_hash AS receipt_proof_hash, pr.provider_payload AS receipt_provider_payload,
        pr.verified_at AS receipt_verified_at
      FROM runs r
      JOIN quotes q ON q.id = r.quote_id
      JOIN payment_orders po ON po.run_id = r.id
      LEFT JOIN payment_receipts pr ON pr.run_id = r.id AND pr.direction = 'CUSTOMER_IN'
      WHERE r.id = $1`,
      [runId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const context = await this.#orderStore.getByDappOrderId(row.run_id);
    if (!context) throw new Error('Payment order context disappeared during reconciliation load');

    const customerPayment = parseCustomerPayment(row, context.order);
    return {
      run: parseRun(row),
      quote: parseQuote(row),
      paymentOrder: context.order,
      ...(row.customer_payment_proof_hash
        ? { customerPaymentProofHash: bufferToHex(row.customer_payment_proof_hash) }
        : {}),
      ...(customerPayment ? { customerPayment } : {}),
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
          input.event.runId,
          input.event.revision,
          input.event.type,
          input.event.actor,
          input.event.idempotencyKey,
          JSON.stringify(input.event),
          input.event.occurredAt,
        ],
      );
      await client.query(
        `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
         VALUES ('RUN', $1, $2, $3::jsonb)`,
        [input.run.id, input.event.type, JSON.stringify(input.event)],
      );
      await client.query(`INSERT INTO orchestrator_jobs (run_id) VALUES ($1) ON CONFLICT (run_id) DO NOTHING`, [
        input.run.id,
      ]);
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
        proof: payment.proof,
        receipt: payment.receipt,
      }),
      payment.verifiedAt,
    ],
  );
}

function parseCustomerPayment(row: FundableRow, order: MerchantOrder): VerifiedCustomerPayment | undefined {
  if (!row.receipt_proof_hash) return undefined;
  if (
    !row.receipt_order_id ||
    !row.receipt_chain_id ||
    !row.receipt_payer ||
    !row.receipt_recipient ||
    !row.receipt_atomic_amount ||
    !row.receipt_transaction_hash ||
    row.receipt_log_index === null ||
    row.receipt_verified_at === null
  ) {
    throw new Error('Stored customer payment receipt is incomplete');
  }

  const payload = persistedPaymentPayloadSchema.parse(row.receipt_provider_payload);
  const proof = payload.proof as MerchantPaymentProof;
  const receipt = payload.receipt as NormalizedTransactionReceipt;
  const transactionHash = bufferToHex(row.receipt_transaction_hash);
  if (
    proof.orderId !== row.receipt_order_id ||
    proof.chainId !== Number(row.receipt_chain_id) ||
    proof.transactionHash.toLowerCase() !== transactionHash.toLowerCase() ||
    proof.logIndex !== row.receipt_log_index ||
    proof.fromAddress.toLowerCase() !== bufferToHex(row.receipt_payer).toLowerCase() ||
    proof.toAddress.toLowerCase() !== bufferToHex(row.receipt_recipient).toLowerCase() ||
    proof.atomicAmount !== row.receipt_atomic_amount ||
    receipt.chainId !== proof.chainId ||
    receipt.transactionHash.toLowerCase() !== transactionHash.toLowerCase()
  ) {
    throw new Error('Stored customer payment payload conflicts with indexed receipt columns');
  }

  return {
    runId: row.run_id,
    order,
    proof,
    receipt,
    proofHash: bufferToHex(row.receipt_proof_hash),
    verifiedAt: toIso(row.receipt_verified_at),
  };
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
