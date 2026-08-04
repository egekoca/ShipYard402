import { randomUUID } from 'node:crypto';

import type { FlowRuntimeCapability } from '@shipyard402/goat-network-config';
import cors from '@fastify/cors';
import {
  QuoteBudgetExceededError,
  QuoteEngine,
  quoteRequestSchema,
  type Quote,
} from '@shipyard402/quote-engine';
import { createDraftRun, transitionRun } from '@shipyard402/run-domain';
import type { X402MerchantAdapter } from '@shipyard402/x402-payments';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  type QuoteRepository,
  type RunRecord,
  type RunRepository,
} from './repositories.js';

const createRunRequestSchema = z
  .object({
    quoteId: z.string().min(8).max(200),
    idempotencyKey: z.string().min(16).max(200),
  })
  .strict();

const runParamsSchema = z.object({ runId: z.string().min(8).max(200) }).strict();

export interface RuntimeCapabilityProvider {
  getShipyardMerchantCapability(): Promise<FlowRuntimeCapability | null>;
}

export type AppDependencies = Readonly<{
  quoteEngine: QuoteEngine;
  quoteRepository: QuoteRepository;
  runRepository: RunRepository;
  capabilityProvider: RuntimeCapabilityProvider;
  merchantAdapter?: X402MerchantAdapter;
  allowedWebOrigins?: readonly string[];
  now?: () => Date;
  idFactory?: () => string;
}>;

export function createApp(dependencies: AppDependencies): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });
  const now = dependencies.now ?? (() => new Date());
  const idFactory = dependencies.idFactory ?? randomUUID;

  if (dependencies.allowedWebOrigins && dependencies.allowedWebOrigins.length > 0) {
    void app.register(cors, {
      origin: [...dependencies.allowedWebOrigins],
      methods: ['GET', 'POST'],
      allowedHeaders: ['content-type', 'authorization', 'idempotency-key'],
      credentials: false,
      maxAge: 600,
    });
  }

  app.get('/health', async () => ({
    status: 'ok',
    service: 'shipyard402-api-gateway',
    mainnetWritesEnabled: false,
    assuranceClaim: 'version-policy-expiry-scoped-execution-evidence',
  }));

  app.post('/v1/quotes', async (request, reply) => {
    const parsed = quoteRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: 'INVALID_QUOTE_REQUEST', issues: parsed.error.issues });
    }

    const capability = await dependencies.capabilityProvider.getShipyardMerchantCapability();
    if (!capability) {
      return reply.code(503).send({
        code: 'RUNTIME_PAYMENT_CAPABILITY_UNAVAILABLE',
        message: 'A verified GOAT Flow ERC20_DIRECT merchant capability is required before quoting.',
      });
    }

    try {
      const quote = dependencies.quoteEngine.createQuote(parsed.data, capability, now());
      await dependencies.quoteRepository.save(quote);
      return reply.code(201).send(toQuoteResponse(quote));
    } catch (error) {
      if (error instanceof QuoteBudgetExceededError) {
        return reply.code(422).send({ code: 'CUSTOMER_BUDGET_EXCEEDED', message: error.message });
      }
      throw error;
    }
  });

  app.post('/v1/runs', async (request, reply) => {
    const parsed = createRunRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: 'INVALID_RUN_REQUEST', issues: parsed.error.issues });
    }

    const existing = await dependencies.runRepository.findByRequestIdempotencyKey(parsed.data.idempotencyKey);
    if (existing) return reply.code(200).send(toRunResponse(existing));

    const quote = await dependencies.quoteRepository.findById(parsed.data.quoteId);
    if (!quote) return reply.code(404).send({ code: 'QUOTE_NOT_FOUND' });
    const timestamp = now();
    if (timestamp.getTime() >= Date.parse(quote.expiresAt)) {
      return reply.code(410).send({ code: 'QUOTE_EXPIRED' });
    }

    const draft = createDraftRun(`run_${idFactory()}`, timestamp.toISOString());
    const quotedTransition = transitionRun(draft, {
      actor: 'QUOTE_ENGINE',
      expectedRevision: draft.revision,
      idempotencyKey: `${parsed.data.idempotencyKey}:quoted`,
      occurredAt: timestamp.toISOString(),
      to: 'QUOTED',
    });
    if (!quotedTransition.event) throw new Error('Initial run transition produced no event');
    const record: RunRecord = {
      aggregate: quotedTransition.run,
      quoteId: quote.id,
      requestIdempotencyKey: parsed.data.idempotencyKey,
      uncommittedEvent: quotedTransition.event,
    };
    try {
      await dependencies.runRepository.save(record);
    } catch (error) {
      const persisted = await dependencies.runRepository.findByRequestIdempotencyKey(parsed.data.idempotencyKey);
      if (persisted) return reply.code(200).send(toRunResponse(persisted));
      throw error;
    }
    return reply.code(201).send(toRunResponse(record));
  });

  app.post('/v1/runs/:runId/payment-challenge', async (request, reply) => {
    const params = runParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ code: 'INVALID_RUN_ID' });
    if (!dependencies.merchantAdapter) {
      return reply.code(503).send({
        code: 'GOAT_FLOW_MERCHANT_ADAPTER_UNAVAILABLE',
        message: 'The backend merchant adapter is not configured.',
      });
    }

    const record = await dependencies.runRepository.findById(params.data.runId);
    if (!record) return reply.code(404).send({ code: 'RUN_NOT_FOUND' });
    if (record.paymentOrder) {
      const recovered = await ensurePaymentRequired(record, dependencies.runRepository, now);
      return reply.code(paymentChallengeHttpStatus(recovered)).send(toRunResponse(recovered));
    }
    if (record.aggregate.status !== 'QUOTED') {
      return reply.code(409).send({ code: 'RUN_NOT_QUOTED', status: record.aggregate.status });
    }
    const quote = await dependencies.quoteRepository.findById(record.quoteId);
    if (!quote) return reply.code(409).send({ code: 'RUN_QUOTE_NOT_FOUND' });
    if (now().getTime() >= Date.parse(quote.expiresAt)) {
      return reply.code(410).send({ code: 'QUOTE_EXPIRED' });
    }

    try {
      const order = await dependencies.merchantAdapter.createOrder({
        dappOrderId: record.aggregate.id,
        payerAddress: quote.request.requesterAddress as `0x${string}`,
        atomicAmount: quote.totalAtomicAmount,
        capability: quote.capabilitySnapshot,
      });
      const orderBoundRecord: RunRecord = {
        ...record,
        paymentOrder: order,
      };
      const updated = await ensurePaymentRequired(orderBoundRecord, dependencies.runRepository, now);
      return reply.code(paymentChallengeHttpStatus(updated)).send(toRunResponse(updated));
    } catch (error) {
      const current = await dependencies.runRepository.findById(record.aggregate.id);
      if (current?.paymentOrder) return reply.code(paymentChallengeHttpStatus(current)).send(toRunResponse(current));
      request.log.error({ err: error, runId: record.aggregate.id }, 'GOAT Flow order creation failed');
      return reply.code(502).send({
        code: 'GOAT_FLOW_ORDER_CREATION_FAILED',
        message: 'The payment challenge could not be created safely.',
      });
    }
  });

  app.get('/v1/runs/:runId', async (request, reply) => {
    const params = runParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ code: 'INVALID_RUN_ID' });
    const record = await dependencies.runRepository.findById(params.data.runId);
    if (!record) return reply.code(404).send({ code: 'RUN_NOT_FOUND' });
    return reply.code(200).send(toRunResponse(record));
  });

  return app;
}

async function ensurePaymentRequired(
  record: RunRecord,
  repository: RunRepository,
  now: () => Date,
): Promise<RunRecord> {
  if (!record.paymentOrder || record.aggregate.status !== 'QUOTED') return record;

  const transition = transitionRun(record.aggregate, {
    actor: 'MERCHANT_GATEWAY',
    expectedRevision: record.aggregate.revision,
    idempotencyKey: `payment-order:${record.paymentOrder.orderId}`,
    occurredAt: now().toISOString(),
    to: 'PAYMENT_REQUIRED',
  });
  if (!transition.event) throw new Error('Payment-required transition produced no event');
  const updated: RunRecord = {
    ...record,
    aggregate: transition.run,
    uncommittedEvent: transition.event,
  };

  try {
    await repository.save(updated, record.aggregate.revision);
    return updated;
  } catch (error) {
    const current = await repository.findById(record.aggregate.id);
    if (current?.paymentOrder && current.aggregate.status !== 'QUOTED') return current;
    throw error;
  }
}

function toQuoteResponse(quote: Quote): object {
  return {
    ...quote,
    nextAction: 'CREATE_GOAT_FLOW_ERC20_DIRECT_ORDER',
    warning: 'Pricing is a hypothesis until real provider, model, chain, and storage costs are measured.',
  };
}

function toRunResponse(record: RunRecord): object {
  const order = record.paymentOrder;
  return {
    run: record.aggregate,
    payment: order
      ? {
          status: order.status,
          mode: 'ERC20_DIRECT',
          nextAction: paymentNextAction(record),
          orderId: order.orderId,
          expiresAt: order.expiresAt,
          paymentRequired: order.paymentRequired,
        }
      : {
          status: 'NOT_CREATED',
          mode: 'ERC20_DIRECT',
          nextAction: 'REQUEST_PAYMENT_CHALLENGE',
        },
  };
}

function paymentNextAction(record: RunRecord): string {
  if (!record.paymentOrder) return 'REQUEST_PAYMENT_CHALLENGE';
  if (record.aggregate.status === 'PAYMENT_REQUIRED') {
    return record.paymentOrder.status === 'CHECKOUT_VERIFIED'
      ? 'PAY_X402_CHALLENGE'
      : 'AWAIT_PAYMENT_RECONCILIATION';
  }
  if (record.aggregate.status === 'FUNDED') return 'CUSTOMER_PAYMENT_VERIFIED';
  return 'CUSTOMER_PAYMENT_RECORDED';
}

function paymentChallengeHttpStatus(record: RunRecord): 200 | 402 {
  return record.aggregate.status === 'PAYMENT_REQUIRED' && record.paymentOrder?.status === 'CHECKOUT_VERIFIED'
    ? 402
    : 200;
}
