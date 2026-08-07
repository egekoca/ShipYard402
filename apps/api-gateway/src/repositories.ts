import type { Quote } from '@shipyard402/quote-engine';
import type { RunAggregate, RunResult, RunStatus, RunTransitionedEvent } from '@shipyard402/run-domain';
import type { MerchantOrder } from '@shipyard402/x402-payments';

export interface QuoteRepository {
  save(quote: Quote): Promise<void>;
  findById(id: string): Promise<Quote | null>;
}

export type RunSummary = Readonly<{
  id: string;
  status: RunStatus;
  result?: RunResult;
  targetServiceId: string;
  createdAt: string;
  updatedAt: string;
}>;

export type RunSummaryPage = Readonly<{
  runs: readonly RunSummary[];
  hasMore: boolean;
}>;

export type RunRecord = Readonly<{
  aggregate: RunAggregate;
  quoteId: string;
  requestIdempotencyKey: string;
  paymentOrder?: MerchantOrder;
  uncommittedEvent?: RunTransitionedEvent;
  /** The customer's actual on-chain funding transaction, once the payment reconciler verifies it. */
  customerPaymentTransactionHash?: `0x${string}`;
  customerPaymentChainId?: number;
}>;

export interface RunRepository {
  save(record: RunRecord, expectedPersistedRevision?: number): Promise<void>;
  findByRequestIdempotencyKey(key: string): Promise<RunRecord | null>;
  findById(id: string): Promise<RunRecord | null>;
  listByRequester(requesterAddress: string, limit?: number, offset?: number): Promise<RunSummaryPage>;
}

export class RunPersistenceConflictError extends Error {
  constructor() {
    super('Run persistence revision conflict');
    this.name = 'RunPersistenceConflictError';
  }
}

export class InMemoryQuoteRepository implements QuoteRepository {
  readonly #quotes = new Map<string, Quote>();

  async save(quote: Quote): Promise<void> {
    this.#quotes.set(quote.id, quote);
  }

  async findById(id: string): Promise<Quote | null> {
    return this.#quotes.get(id) ?? null;
  }
}

export class InMemoryRunRepository implements RunRepository {
  readonly #runsByRequestKey = new Map<string, RunRecord>();
  readonly #runsById = new Map<string, RunRecord>();

  async save(record: RunRecord, expectedPersistedRevision?: number): Promise<void> {
    const currentByKey = this.#runsByRequestKey.get(record.requestIdempotencyKey);
    if (currentByKey && currentByKey.aggregate.id !== record.aggregate.id) {
      throw new Error('Idempotency key already belongs to another run');
    }
    const current = this.#runsById.get(record.aggregate.id);
    if (expectedPersistedRevision !== undefined && current?.aggregate.revision !== expectedPersistedRevision) {
      throw new RunPersistenceConflictError();
    }
    const persisted = withoutUncommittedEvent(record);
    this.#runsByRequestKey.set(record.requestIdempotencyKey, persisted);
    this.#runsById.set(record.aggregate.id, persisted);
  }

  async findByRequestIdempotencyKey(key: string): Promise<RunRecord | null> {
    return this.#runsByRequestKey.get(key) ?? null;
  }

  async findById(id: string): Promise<RunRecord | null> {
    return this.#runsById.get(id) ?? null;
  }

  // RunRecord never carried a requester address in-memory (only the persisted Postgres row does,
  // sourced from the quote), so this test double can't filter by it. Real filtering is exercised
  // against Postgres directly; this just keeps the interface satisfiable for route-level tests.
  async listByRequester(): Promise<RunSummaryPage> {
    return { runs: [], hasMore: false };
  }
}

function withoutUncommittedEvent(record: RunRecord): RunRecord {
  return {
    aggregate: record.aggregate,
    quoteId: record.quoteId,
    requestIdempotencyKey: record.requestIdempotencyKey,
    ...(record.paymentOrder === undefined ? {} : { paymentOrder: record.paymentOrder }),
  };
}
