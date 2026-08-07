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
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';

import {
  type QuoteRepository,
  type RunRecord,
  type RunRepository,
} from './repositories.js';
import { issueSessionToken, verifyLoginSignature, verifySessionToken, type Session } from './session-auth.js';

const SESSION_TOKEN_VALIDITY_SECONDS = 24 * 60 * 60;

const loginRequestSchema = z
  .object({
    address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    signature: z.string().regex(/^0x[a-fA-F0-9]{130}$/),
    issuedAt: z.number().int().positive(),
  })
  .strict();

const createRunRequestSchema = z
  .object({
    quoteId: z.string().min(8).max(200),
    idempotencyKey: z.string().min(16).max(200),
  })
  .strict();

const runParamsSchema = z.object({ runId: z.string().min(8).max(200) }).strict();

const listRunsQuerySchema = z
  .object({
    requester: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    limit: z.coerce.number().int().min(1).max(50).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .strict();

const onboardingHttpsUrlSchema = z.string().url().refine((value) => new URL(value).protocol === 'https:', 'HTTPS is required');

const onboardServiceRequestSchema = z
  .object({
    organizationName: z.string().min(1).max(200),
    requesterAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    externalServiceId: z.string().min(1).max(200),
    serviceName: z.string().min(1).max(200),
    x402Endpoint: onboardingHttpsUrlSchema,
    openApiUrl: onboardingHttpsUrlSchema,
    version: z.string().min(1).max(100),
  })
  .strict();

export interface RuntimeCapabilityProvider {
  getShipyardMerchantCapability(): Promise<FlowRuntimeCapability | null>;
}

export type RuntimeStatus = Readonly<{
  status: 'ok' | 'degraded' | 'unavailable';
  environment: 'development' | 'test' | 'production';
  persistence: 'postgresql' | 'memory';
  database: 'connected' | 'unavailable' | 'not_configured';
  merchantPayments: 'configured' | 'not_configured';
  /** True only once a reviewed merchant capability is configured AND it targets GOAT mainnet -- a
   * testnet3 merchant, however fully configured, must never report this as true. */
  mainnetWritesEnabled: boolean;
}>;

export interface RuntimeStatusProvider {
  getRuntimeStatus(): Promise<RuntimeStatus>;
}

export type PublicEvidencePack = Readonly<{
  runId: string;
  evidenceRoot: `0x${string}`;
  toolReceiptRoot: `0x${string}`;
  uri: string;
  contentHash: `0x${string}`;
  publicManifest: unknown;
  builtAt: string;
}>;

export interface EvidencePackProvider {
  getByRunId(runId: string): Promise<PublicEvidencePack | null>;
}

export type PublicAttestation = Readonly<{
  runId: string;
  registryAddress: `0x${string}`;
  chainId: number;
  transactionHash: `0x${string}`;
  attestor: `0x${string}`;
  expiresAt: string;
  submittedAt: string;
}>;

export interface AttestationProvider {
  getByRunId(runId: string): Promise<PublicAttestation | null>;
}

export type PublicPlan = Readonly<{
  runId: string;
  riskLevel: string;
  scenarios: readonly string[];
  toolBudgetAtomic: string;
  rationale: string;
  /** The AI's raw, pre-compilation proposal -- advisory only, kept for transparency. */
  aiProposal?: unknown;
}>;

/**
 * Exposes the orchestrator's compiled test plan as soon as it exists (right after
 * PLAN_COMPILED), well before the full evidence pack is built -- without this, a run's AI-risk
 * step visibly finishes on the pipeline stepper while its own detail card has nothing to show
 * for minutes, because the evidence pack (the only other place this data lived) isn't ready
 * until much later.
 */
export interface PlanProvider {
  getByRunId(runId: string): Promise<PublicPlan | null>;
}

export type PublicStepDurationStats = Readonly<{
  /** Number of completed runs the medians were computed from -- smallest bucket sample size. */
  sampleSize: number;
  medianMillisecondsByStep: Readonly<
    Partial<Record<'payment' | 'plan' | 'procurement' | 'evidence' | 'attestation', number>>
  >;
}>;

/**
 * Backs the pipeline stepper's "typically takes ~Xs" hint with real historical durations instead
 * of a guessed number -- computed from how long recent completed runs actually spent on each
 * step, not a static estimate.
 */
export interface StepDurationStatsProvider {
  getRecentMedianDurations(): Promise<PublicStepDurationStats | null>;
}

export type OnboardedService = Readonly<{
  organizationId: string;
  targetServiceId: string;
  targetVersionHash: `0x${string}`;
  policyHash: `0x${string}`;
  x402Endpoint: string;
  openApiUrl: string;
}>;

export type ServiceOnboardingInput = Readonly<{
  organizationName: string;
  requesterAddress: `0x${string}`;
  externalServiceId: string;
  serviceName: string;
  x402Endpoint: string;
  openApiUrl: string;
  version: string;
}>;

/**
 * Before this, the only quotable target was one hardcoded catalog row seeded outside the app --
 * real self-service meant fetching a caller's own OpenAPI document, hashing it into a real
 * version_hash, and registering the catalog rows a quote request actually needs to match against.
 */
export interface ServiceOnboardingProvider {
  onboard(input: ServiceOnboardingInput): Promise<OnboardedService>;
}

export type AppDependencies = Readonly<{
  quoteEngine: QuoteEngine;
  quoteRepository: QuoteRepository;
  runRepository: RunRepository;
  capabilityProvider: RuntimeCapabilityProvider;
  merchantAdapter?: X402MerchantAdapter;
  runtimeStatusProvider?: RuntimeStatusProvider;
  evidencePackProvider?: EvidencePackProvider;
  attestationProvider?: AttestationProvider;
  planProvider?: PlanProvider;
  stepDurationStatsProvider?: StepDurationStatsProvider;
  serviceOnboardingProvider?: ServiceOnboardingProvider;
  allowedWebOrigins?: readonly string[];
  now?: () => Date;
  idFactory?: () => string;
  /**
   * Signs and verifies session bearer tokens (see session-auth.ts). Undefined means auth is
   * unconfigured -- every route that would otherwise trust a caller-supplied address instead
   * fails closed with 503, the same pattern used for the merchant capability above, rather than
   * silently running open.
   */
  sessionSecret?: string;
}>;

export function createApp(dependencies: AppDependencies): FastifyInstance {
  const app = Fastify({
    logger: { level: process.env['NODE_ENV'] === 'test' ? 'silent' : 'info' },
    bodyLimit: 256 * 1024,
  });
  const now = dependencies.now ?? (() => new Date());
  const idFactory = dependencies.idFactory ?? randomUUID;

  // Without this, Fastify's default handler serializes any unhandled exception's raw
  // error.message straight into the HTTP response -- including driver-level Postgres errors from
  // an unguarded repository call, which can carry connection/constraint detail no anonymous
  // caller should see. Every route below that classifies its own errors into a {code, message}
  // shape still does so explicitly; this is only the fallback for whatever slips past that.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error({ err: error }, 'unhandled route error');
    const statusCode = typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500
      ? error.statusCode
      : 500;
    if (statusCode < 500) {
      return reply.code(statusCode).send({ code: 'BAD_REQUEST', message: error.message });
    }
    return reply.code(500).send({ code: 'INTERNAL_ERROR', message: 'An internal error occurred.' });
  });

  if (dependencies.allowedWebOrigins && dependencies.allowedWebOrigins.length > 0) {
    void app.register(cors, {
      origin: [...dependencies.allowedWebOrigins],
      methods: ['GET', 'POST'],
      allowedHeaders: ['content-type', 'authorization', 'idempotency-key'],
      credentials: false,
      maxAge: 600,
    });
  }

  app.get('/health', async (_request, reply) => {
    const runtime = dependencies.runtimeStatusProvider
      ? await dependencies.runtimeStatusProvider.getRuntimeStatus()
      : {
          status: 'ok' as const,
          environment: 'test' as const,
          persistence: 'memory' as const,
          database: 'not_configured' as const,
          merchantPayments: dependencies.merchantAdapter ? 'configured' as const : 'not_configured' as const,
          mainnetWritesEnabled: false,
        };
    return reply.code(runtime.status === 'unavailable' ? 503 : 200).send({
      ...runtime,
      service: 'shipyard402-api-gateway',
      assuranceClaim: 'version-policy-expiry-scoped-execution-evidence',
    });
  });

  /**
   * A wallet signs this once, right after connecting, to prove control of its address; the
   * resulting bearer token is then attached to every request that needs to prove "this caller is
   * this address" (quoting, creating a run, reading a run's own progress). Requiring a fresh
   * signature on every request instead would mean a MetaMask popup on every poll -- a token traded
   * for one signature is what makes that usable.
   */
  app.post('/v1/auth/session', async (request, reply) => {
    if (!dependencies.sessionSecret) {
      return reply.code(503).send({ code: 'AUTH_NOT_CONFIGURED', message: 'Session authentication is not configured.' });
    }
    const parsed = loginRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: 'INVALID_LOGIN_REQUEST', issues: parsed.error.issues });

    const nowEpochSeconds = Math.floor(now().getTime() / 1_000);
    const address = parsed.data.address as `0x${string}`;
    const valid = await verifyLoginSignature({
      address,
      signature: parsed.data.signature as `0x${string}`,
      issuedAtEpochSeconds: parsed.data.issuedAt,
      nowEpochSeconds,
    });
    if (!valid) return reply.code(401).send({ code: 'LOGIN_SIGNATURE_INVALID' });

    const token = issueSessionToken(dependencies.sessionSecret, address, nowEpochSeconds, SESSION_TOKEN_VALIDITY_SECONDS);
    return reply.code(200).send({ token, expiresAt: new Date((nowEpochSeconds + SESSION_TOKEN_VALIDITY_SECONDS) * 1_000).toISOString() });
  });

  function requireSession(request: FastifyRequest, reply: FastifyReply): Session | null {
    if (!dependencies.sessionSecret) {
      reply.code(503).send({ code: 'AUTH_NOT_CONFIGURED', message: 'Session authentication is not configured.' });
      return null;
    }
    const header = request.headers.authorization;
    const token = header && header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) {
      reply.code(401).send({ code: 'AUTH_REQUIRED' });
      return null;
    }
    const session = verifySessionToken(dependencies.sessionSecret, token, Math.floor(now().getTime() / 1_000));
    if (!session) {
      reply.code(401).send({ code: 'AUTH_INVALID_OR_EXPIRED' });
      return null;
    }
    return session;
  }

  /**
   * Loads a run only if the authenticated caller actually owns it (via the quote it was created
   * from). A mismatch reads back identically to a genuinely missing run -- confirming a run exists
   * for someone else's runId is its own small leak, so "not yours" and "doesn't exist" are
   * deliberately indistinguishable from the response alone.
   */
  async function loadOwnedRun(runId: string, callerAddress: string): Promise<RunRecord | null> {
    const record = await dependencies.runRepository.findById(runId);
    if (!record) return null;
    const quote = await dependencies.quoteRepository.findById(record.quoteId);
    if (!quote) return null;
    if (quote.request.requesterAddress.toLowerCase() !== callerAddress.toLowerCase()) return null;
    return record;
  }

  app.get('/v1/stats/step-durations', async (_request, reply) => {
    const stats = dependencies.stepDurationStatsProvider
      ? await dependencies.stepDurationStatsProvider.getRecentMedianDurations()
      : null;
    // Optional enhancement, not a resource lookup -- an unconfigured provider or a fresh
    // install with no completed runs yet both just mean "no ETA hint available", not an error.
    return reply.code(200).send(stats ?? { sampleSize: 0, medianMillisecondsByStep: {} });
  });

  app.post('/v1/services/onboard', async (request, reply) => {
    const session = requireSession(request, reply);
    if (!session) return;
    const parsed = onboardServiceRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: 'INVALID_ONBOARDING_REQUEST', issues: parsed.error.issues });
    }
    if (parsed.data.requesterAddress.toLowerCase() !== session.address.toLowerCase()) {
      return reply.code(403).send({ code: 'REQUESTER_ADDRESS_MISMATCH' });
    }
    if (!dependencies.serviceOnboardingProvider) {
      return reply.code(503).send({
        code: 'SERVICE_ONBOARDING_UNAVAILABLE',
        message: 'Catalog onboarding storage is not configured.',
      });
    }
    try {
      const onboarded = await dependencies.serviceOnboardingProvider.onboard({
        ...parsed.data,
        requesterAddress: parsed.data.requesterAddress as `0x${string}`,
      });
      return reply.code(201).send(onboarded);
    } catch (error) {
      const code = hasErrorCode(error, 'OPENAPI_HOST_FORBIDDEN')
        ? 'OPENAPI_HOST_FORBIDDEN'
        : hasErrorCode(error, 'OPENAPI_NOT_JSON')
        ? 'OPENAPI_NOT_JSON'
        : hasErrorCode(error, 'OPENAPI_FETCH_FAILED')
        ? 'OPENAPI_FETCH_FAILED'
        : null;
      if (code) {
        return reply.code(422).send({ code, message: error instanceof Error ? error.message : 'Onboarding failed' });
      }
      throw error;
    }
  });

  app.post('/v1/quotes', async (request, reply) => {
    const session = requireSession(request, reply);
    if (!session) return;
    const parsed = quoteRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: 'INVALID_QUOTE_REQUEST', issues: parsed.error.issues });
    }
    if (parsed.data.requesterAddress.toLowerCase() !== session.address.toLowerCase()) {
      return reply.code(403).send({ code: 'REQUESTER_ADDRESS_MISMATCH' });
    }

    let capability: FlowRuntimeCapability | null;
    try {
      capability = await dependencies.capabilityProvider.getShipyardMerchantCapability();
    } catch (error) {
      request.log.error({ err: error }, 'GOAT x402 merchant capability discovery failed');
      return reply.code(503).send({
        code: 'RUNTIME_PAYMENT_CAPABILITY_UNAVAILABLE',
        message: 'The reviewed GOAT x402 merchant capability could not be verified.',
      });
    }
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
      if (hasErrorCode(error, 'QUOTE_TARGET_NOT_ONBOARDED')) {
        return reply.code(409).send({
          code: 'QUOTE_TARGET_NOT_ONBOARDED',
          message: 'The service release and policy must be onboarded before a durable quote can be created.',
        });
      }
      throw error;
    }
  });

  app.post('/v1/runs', async (request, reply) => {
    const session = requireSession(request, reply);
    if (!session) return;
    const parsed = createRunRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: 'INVALID_RUN_REQUEST', issues: parsed.error.issues });
    }

    const existing = await dependencies.runRepository.findByRequestIdempotencyKey(parsed.data.idempotencyKey);
    if (existing) {
      // request_idempotency_key is only unique on its own (no quoteId component) -- a client that
      // reuses a key against a different quote (e.g. re-quoting after expiry, then retrying the
      // old idempotencyKey) must get a clear conflict, not someone else's run silently handed back
      // as if it were theirs. A key that happens to collide with a run belonging to a different
      // authenticated caller entirely reads back as not-found, same as any other ownership miss.
      if (existing.quoteId !== parsed.data.quoteId) {
        return reply.code(409).send({ code: 'IDEMPOTENCY_KEY_QUOTE_MISMATCH' });
      }
      const owned = await loadOwnedRun(existing.aggregate.id, session.address);
      if (!owned) return reply.code(404).send({ code: 'RUN_NOT_FOUND' });
      return reply.code(200).send(toRunResponse(owned));
    }

    const quote = await dependencies.quoteRepository.findById(parsed.data.quoteId);
    if (!quote) return reply.code(404).send({ code: 'QUOTE_NOT_FOUND' });
    if (quote.request.requesterAddress.toLowerCase() !== session.address.toLowerCase()) {
      return reply.code(403).send({ code: 'REQUESTER_ADDRESS_MISMATCH' });
    }
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
      if (persisted) {
        if (persisted.quoteId !== parsed.data.quoteId) {
          return reply.code(409).send({ code: 'IDEMPOTENCY_KEY_QUOTE_MISMATCH' });
        }
        return reply.code(200).send(toRunResponse(persisted));
      }
      throw error;
    }
    return reply.code(201).send(toRunResponse(record));
  });

  app.post('/v1/runs/:runId/payment-challenge', async (request, reply) => {
    const params = runParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ code: 'INVALID_RUN_ID' });
    const session = requireSession(request, reply);
    if (!session) return;
    if (!dependencies.merchantAdapter) {
      return reply.code(503).send({
        code: 'GOAT_FLOW_MERCHANT_ADAPTER_UNAVAILABLE',
        message: 'The backend merchant adapter is not configured.',
      });
    }

    const record = await loadOwnedRun(params.data.runId, session.address);
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

  app.get('/v1/runs', async (request, reply) => {
    const query = listRunsQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ code: 'INVALID_REQUESTER_ADDRESS' });
    const session = requireSession(request, reply);
    if (!session) return;
    if (query.data.requester.toLowerCase() !== session.address.toLowerCase()) {
      return reply.code(403).send({ code: 'REQUESTER_ADDRESS_MISMATCH' });
    }
    const page = await dependencies.runRepository.listByRequester(query.data.requester, query.data.limit, query.data.offset);
    return reply.code(200).send(page);
  });

  app.get('/v1/runs/:runId', async (request, reply) => {
    const params = runParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ code: 'INVALID_RUN_ID' });
    const session = requireSession(request, reply);
    if (!session) return;
    const record = await loadOwnedRun(params.data.runId, session.address);
    if (!record) return reply.code(404).send({ code: 'RUN_NOT_FOUND' });
    return reply.code(200).send(toRunResponse(record));
  });

  app.get('/v1/runs/:runId/plan', async (request, reply) => {
    const params = runParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ code: 'INVALID_RUN_ID' });
    const session = requireSession(request, reply);
    if (!session) return;
    if (!(await loadOwnedRun(params.data.runId, session.address))) {
      return reply.code(404).send({ code: 'RUN_NOT_FOUND' });
    }
    if (!dependencies.planProvider) {
      return reply.code(503).send({
        code: 'PLAN_PROVIDER_UNAVAILABLE',
        message: 'Orchestrator plan storage is not configured.',
      });
    }
    const plan = await dependencies.planProvider.getByRunId(params.data.runId);
    if (!plan) return reply.code(404).send({ code: 'PLAN_NOT_FOUND' });
    return reply.code(200).send(plan);
  });

  app.get('/v1/runs/:runId/evidence', async (request, reply) => {
    const params = runParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ code: 'INVALID_RUN_ID' });
    const session = requireSession(request, reply);
    if (!session) return;
    if (!(await loadOwnedRun(params.data.runId, session.address))) {
      return reply.code(404).send({ code: 'RUN_NOT_FOUND' });
    }
    if (!dependencies.evidencePackProvider) {
      return reply.code(503).send({
        code: 'EVIDENCE_PACK_PROVIDER_UNAVAILABLE',
        message: 'Evidence pack storage is not configured.',
      });
    }
    const pack = await dependencies.evidencePackProvider.getByRunId(params.data.runId);
    if (!pack) return reply.code(404).send({ code: 'EVIDENCE_PACK_NOT_FOUND' });
    return reply.code(200).send(pack);
  });

  app.get('/v1/runs/:runId/attestation', async (request, reply) => {
    const params = runParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ code: 'INVALID_RUN_ID' });
    const session = requireSession(request, reply);
    if (!session) return;
    if (!(await loadOwnedRun(params.data.runId, session.address))) {
      return reply.code(404).send({ code: 'RUN_NOT_FOUND' });
    }
    if (!dependencies.attestationProvider) {
      return reply.code(503).send({
        code: 'ATTESTATION_PROVIDER_UNAVAILABLE',
        message: 'Attestation storage is not configured.',
      });
    }
    const attestation = await dependencies.attestationProvider.getByRunId(params.data.runId);
    if (!attestation) return reply.code(404).send({ code: 'ATTESTATION_NOT_FOUND' });
    return reply.code(200).send(attestation);
  });

  return app;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
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
          ...(record.customerPaymentTransactionHash ? { transactionHash: record.customerPaymentTransactionHash } : {}),
          ...(record.customerPaymentChainId ? { chainId: record.customerPaymentChainId } : {}),
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
