import { quoteSchema, type Quote } from '@shipyard402/quote-engine';
import {
  RUN_RESULTS,
  RUN_STATUSES,
  type RunAggregate,
  type RunResult,
  type RunStatus,
  type RunTransitionedEvent,
} from '@shipyard402/run-domain';
import type { MerchantOrder } from '@shipyard402/x402-payments';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

import { PostgresFlowOrderContextStore } from './flow-order-context-store.js';

export type ApiRunRecord = Readonly<{
  aggregate: RunAggregate;
  quoteId: string;
  requestIdempotencyKey: string;
  paymentOrder?: MerchantOrder;
  uncommittedEvent?: RunTransitionedEvent;
}>;

type QuoteRow = QueryResultRow & {
  id: string;
  request_snapshot: unknown;
  capability_snapshot: unknown;
  pricing_status: string;
  line_items: unknown;
  total_atomic_amount: string;
  refundable_tool_budget_atomic: string;
  created_at: Date | string;
  expires_at: Date | string;
  quote_commitment: Buffer;
};

type RunRow = QueryResultRow & {
  id: string;
  quote_id: string;
  request_idempotency_key: string;
  status: string;
  result: string | null;
  revision: string;
  created_at: Date | string;
  updated_at: Date | string;
  applied_keys: string[];
  order_id: string | null;
};

export class PostgresQuoteRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async save(quote: Quote): Promise<void> {
    const validated = quoteSchema.parse(quote);
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const binding = await resolveCatalogBinding(client, validated);
      await client.query(
        `INSERT INTO quotes (
          id, organization_id, service_id, release_id, policy_id, requester,
          request_snapshot, capability_snapshot, line_items, payment_chain_id,
          payment_token, total_atomic_amount, refundable_tool_budget_atomic,
          pricing_status, quote_commitment, created_at, expires_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7::jsonb, $8::jsonb, $9::jsonb, $10,
          $11, $12, $13, $14, $15, $16, $17
        )`,
        [
          validated.id,
          validated.request.organizationId,
          binding.serviceId,
          binding.releaseId,
          binding.policyId,
          hexToBuffer(validated.request.requesterAddress),
          JSON.stringify(validated.request),
          JSON.stringify(validated.capabilitySnapshot),
          JSON.stringify(validated.lineItems),
          validated.capabilitySnapshot.chainId,
          hexToBuffer(validated.capabilitySnapshot.tokenAddress),
          validated.totalAtomicAmount,
          validated.refundableToolBudgetAtomic,
          validated.pricingStatus,
          hexToBuffer(validated.quoteCommitment),
          validated.createdAt,
          validated.expiresAt,
        ],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async findById(id: string): Promise<Quote | null> {
    const result = await this.#pool.query<QuoteRow>(
      `SELECT
        id, request_snapshot, capability_snapshot, pricing_status, line_items,
        total_atomic_amount::text, refundable_tool_budget_atomic::text,
        created_at, expires_at, quote_commitment
      FROM quotes WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? parseQuoteRow(row) : null;
  }
}

export class PostgresRunRepository {
  readonly #pool: Pool;
  readonly #orderStore: PostgresFlowOrderContextStore;

  constructor(pool: Pool) {
    this.#pool = pool;
    this.#orderStore = new PostgresFlowOrderContextStore(pool);
  }

  async save(record: ApiRunRecord, expectedPersistedRevision?: number): Promise<void> {
    if (!record.uncommittedEvent) throw new Error('PostgreSQL run save requires its uncommitted domain event');
    if (record.uncommittedEvent.runId !== record.aggregate.id || record.uncommittedEvent.revision !== record.aggregate.revision) {
      throw new Error('Run aggregate and uncommitted event are not revision-aligned');
    }
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      if (expectedPersistedRevision === undefined) {
        await insertRun(client, record);
      } else {
        const updated = await client.query(
          `UPDATE runs SET status = $2, result = $3, revision = $4, updated_at = $5
           WHERE id = $1 AND revision = $6`,
          [
            record.aggregate.id,
            record.aggregate.status,
            record.aggregate.result ?? null,
            record.aggregate.revision,
            record.aggregate.updatedAt,
            expectedPersistedRevision,
          ],
        );
        if (updated.rowCount !== 1) throw new Error('Run persistence revision conflict');
      }
      await insertEventAndOutbox(client, record.uncommittedEvent);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async findByRequestIdempotencyKey(key: string): Promise<ApiRunRecord | null> {
    return this.#find('r.request_idempotency_key = $1', key);
  }

  async findById(id: string): Promise<ApiRunRecord | null> {
    return this.#find('r.id = $1', id);
  }

  async #find(predicate: string, value: string): Promise<ApiRunRecord | null> {
    const result = await this.#pool.query<RunRow>(
      `SELECT
        r.id, r.quote_id, r.request_idempotency_key, r.status, r.result,
        r.revision::text, r.created_at, r.updated_at,
        ARRAY(SELECT e.idempotency_key FROM run_events e WHERE e.run_id = r.id ORDER BY e.revision) AS applied_keys,
        po.order_id
      FROM runs r
      LEFT JOIN payment_orders po ON po.run_id = r.id
      WHERE ${predicate}`,
      [value],
    );
    const row = result.rows[0];
    if (!row) return null;
    const paymentContext = row.order_id ? await this.#orderStore.get(row.order_id) : null;
    return {
      aggregate: parseRunRow(row),
      quoteId: row.quote_id,
      requestIdempotencyKey: row.request_idempotency_key,
      ...(paymentContext ? { paymentOrder: paymentContext.order } : {}),
    };
  }
}

async function resolveCatalogBinding(
  client: PoolClient,
  quote: Quote,
): Promise<{ serviceId: string; releaseId: string; policyId: string }> {
  const result = await client.query<{ service_id: string; release_id: string; policy_id: string }>(
    `SELECT s.id AS service_id, r.id AS release_id, p.id AS policy_id
     FROM services s
     JOIN releases r ON r.service_id = s.id AND r.version_hash = $5
     JOIN policies p ON p.policy_hash = $6
     WHERE s.organization_id = $1
       AND s.external_service_id = $2
       AND s.x402_endpoint = $3
       AND s.openapi_url = $4
       AND s.active = true`,
    [
      quote.request.organizationId,
      quote.request.targetServiceId,
      quote.request.x402Endpoint,
      quote.request.openApiUrl,
      hexToBuffer(quote.request.targetVersionHash),
      hexToBuffer(quote.request.policyHash),
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error('Quote target is not bound to an active onboarded service, release, and policy');
  }
  return { serviceId: row.service_id, releaseId: row.release_id, policyId: row.policy_id };
}

async function insertRun(client: PoolClient, record: ApiRunRecord): Promise<void> {
  const quote = await client.query<{
    service_id: string;
    release_id: string;
    policy_id: string;
    requester: Buffer;
  }>(
    `SELECT service_id, release_id, policy_id, requester FROM quotes WHERE id = $1 FOR SHARE`,
    [record.quoteId],
  );
  const binding = quote.rows[0];
  if (!binding) throw new Error('Run quote binding does not exist');
  await client.query(
    `INSERT INTO runs (
      id, quote_id, service_id, release_id, policy_id, request_idempotency_key,
      requester, status, result, revision, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      record.aggregate.id,
      record.quoteId,
      binding.service_id,
      binding.release_id,
      binding.policy_id,
      record.requestIdempotencyKey,
      binding.requester,
      record.aggregate.status,
      record.aggregate.result ?? null,
      record.aggregate.revision,
      record.aggregate.createdAt,
      record.aggregate.updatedAt,
    ],
  );
}

async function insertEventAndOutbox(client: PoolClient, event: RunTransitionedEvent): Promise<void> {
  await client.query(
    `INSERT INTO run_events (run_id, revision, event_type, actor, idempotency_key, payload, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [event.runId, event.revision, event.type, event.actor, event.idempotencyKey, JSON.stringify(event), event.occurredAt],
  );
  await client.query(
    `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
     VALUES ('RUN', $1, $2, $3::jsonb)`,
    [event.runId, event.type, JSON.stringify(event)],
  );
}

function parseQuoteRow(row: QuoteRow): Quote {
  return quoteSchema.parse({
    id: row.id,
    request: row.request_snapshot,
    capabilitySnapshot: row.capability_snapshot,
    pricingStatus: row.pricing_status,
    lineItems: row.line_items,
    totalAtomicAmount: row.total_atomic_amount,
    refundableToolBudgetAtomic: row.refundable_tool_budget_atomic,
    createdAt: toIso(row.created_at),
    expiresAt: toIso(row.expires_at),
    quoteCommitment: bufferToHex(row.quote_commitment),
  });
}

function parseRunRow(row: RunRow): RunAggregate {
  const status = parseStatus(row.status);
  const result = row.result === null ? undefined : parseResult(row.result);
  return {
    id: row.id,
    status,
    ...(result === undefined ? {} : { result }),
    revision: Number(row.revision),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    appliedIdempotencyKeys: row.applied_keys,
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
