import { QuoteEngine } from '@shipyard402/quote-engine';
import type { X402MerchantAdapter } from '@shipyard402/x402-payments';
import { afterEach, describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';

import { createApp, type AttestationProvider, type EvidencePackProvider } from './app.js';
import { InMemoryQuoteRepository, InMemoryRunRepository, type RunRepository } from './repositories.js';
import { issueSessionToken, loginMessage } from './session-auth.js';

const TEST_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
const NOW = new Date('2026-08-04T10:00:00.000Z');
const NOW_EPOCH = Math.floor(NOW.getTime() / 1_000);

const requesterKey = `0x${'55'.repeat(32)}` as const;
const requesterAddress = privateKeyToAccount(requesterKey).address;

const capability = {
  environment: 'mainnet',
  merchantId: 'shipyard',
  mode: 'ERC20_DIRECT',
  chainId: 2345,
  tokenAddress: '0x1000000000000000000000000000000000000001',
  tokenSymbol: 'TEST_ONLY',
  tokenDecimals: 6,
  receivingAddress: '0x3000000000000000000000000000000000000003',
  minimumAtomicAmount: '1',
  maximumAtomicAmount: '100000000',
  discoveredAt: '2026-08-04T10:00:00.000Z',
  source: 'AUTHENTICATED_API',
} as const;

const quoteBody = {
  organizationId: '7d575e3d-a625-4b71-a28b-86dc202d1d7f',
  requesterAddress,
  targetAgentId: 'agent:184',
  targetServiceId: 'service:external',
  targetVersionHash: `0x${'11'.repeat(32)}`,
  policyHash: `0x${'22'.repeat(32)}`,
  x402Endpoint: 'https://target.example/api/paid',
  openApiUrl: 'https://target.example/openapi.json',
  maximumCustomerBudgetAtomic: '6000000',
};

const apps: ReturnType<typeof createApp>[] = [];

const merchantAdapter: X402MerchantAdapter = {
  async discoverRuntimeCapabilities() {
    return [capability];
  },
  async createOrder(input) {
    return {
      orderId: 'flow-order-fixed',
      dappOrderId: input.dappOrderId,
      status: 'CHECKOUT_VERIFIED',
      chainId: 2345,
      tokenAddress: capability.tokenAddress,
      atomicAmount: input.atomicAmount,
      payerAddress: input.payerAddress,
      payToAddress: capability.receivingAddress,
      expiresAt: '2026-08-04T10:15:00.000Z',
      paymentRequired: {
        x402Version: 2,
        resource: { url: 'https://shipyard.example/v1/runs' },
        accepts: [
          {
            scheme: 'exact',
            network: 'eip155:2345',
            amount: input.atomicAmount,
            asset: capability.tokenAddress,
            payTo: capability.receivingAddress,
            maxTimeoutSeconds: 900,
          },
        ],
      },
    };
  },
  async getOrderStatus() {
    throw new Error('Not used in API tests');
  },
  async getOrderProof() {
    throw new Error('Not used in API tests');
  },
};

/** A session token for `address`, signed with the same secret every testApp() is configured with. */
function authHeaderFor(address: `0x${string}`): Readonly<{ authorization: string }> {
  return { authorization: `Bearer ${issueSessionToken(TEST_SESSION_SECRET, address, NOW_EPOCH, 3_600)}` };
}

const requesterAuth = authHeaderFor(requesterAddress);

function testApp(
  withCapability = true,
  overrides: Readonly<{
    runRepository?: RunRepository;
    evidencePackProvider?: EvidencePackProvider;
    attestationProvider?: AttestationProvider;
    sessionSecret?: string;
  }> = {},
): ReturnType<typeof createApp> {
  const app = createApp({
    capabilityProvider: {
      async getShipyardMerchantCapability() {
        return withCapability ? capability : null;
      },
    },
    quoteEngine: new QuoteEngine(
      {
        pricingStatus: 'HYPOTHESIS',
        feeRateBps: 500,
        mandatoryToolBudgetAtomic: '800000',
        dynamicToolBudgetAtomic: '300000',
        modelInfrastructureReserveAtomic: '100000',
        chainStorageReserveAtomic: '50000',
        riskSupportReserveAtomic: '100000',
        quoteTtlSeconds: 900,
      },
      () => 'quote-fixed',
    ),
    quoteRepository: new InMemoryQuoteRepository(),
    runRepository: overrides.runRepository ?? new InMemoryRunRepository(),
    now: () => NOW,
    idFactory: () => 'run-fixed',
    merchantAdapter,
    sessionSecret: 'sessionSecret' in overrides ? overrides.sessionSecret : TEST_SESSION_SECRET,
    ...(overrides.evidencePackProvider ? { evidencePackProvider: overrides.evidencePackProvider } : {}),
    ...(overrides.attestationProvider ? { attestationProvider: overrides.attestationProvider } : {}),
  });
  apps.push(app);
  return app;
}

/** Creates a real QUOTED run owned by `requesterAddress`, returning its id -- most protected-route
 * tests need a run that genuinely belongs to the caller for the new ownership check to pass. */
async function createOwnedRun(app: ReturnType<typeof createApp>, idempotencyKey: string): Promise<string> {
  const quoteResponse = await app.inject({
    method: 'POST',
    url: '/v1/quotes',
    payload: quoteBody,
    headers: requesterAuth,
  });
  const runResponse = await app.inject({
    method: 'POST',
    url: '/v1/runs',
    payload: { quoteId: quoteResponse.json().id, idempotencyKey },
    headers: requesterAuth,
  });
  return runResponse.json().run.id as string;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('api gateway vertical slice', () => {
  it('reports persistence and merchant readiness without claiming signer access', async () => {
    const app = createApp({
      capabilityProvider: {
        async getShipyardMerchantCapability() {
          return null;
        },
      },
      quoteEngine: new QuoteEngine({
        pricingStatus: 'HYPOTHESIS',
        feeRateBps: 500,
        mandatoryToolBudgetAtomic: '1',
        dynamicToolBudgetAtomic: '1',
        modelInfrastructureReserveAtomic: '1',
        chainStorageReserveAtomic: '1',
        riskSupportReserveAtomic: '1',
        quoteTtlSeconds: 60,
      }),
      quoteRepository: new InMemoryQuoteRepository(),
      runRepository: new InMemoryRunRepository(),
      runtimeStatusProvider: {
        async getRuntimeStatus() {
          return {
            status: 'degraded',
            environment: 'development',
            persistence: 'postgresql',
            database: 'connected',
            merchantPayments: 'not_configured',
            mainnetWritesEnabled: false,
          };
        },
      },
    });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'degraded',
      persistence: 'postgresql',
      database: 'connected',
      merchantPayments: 'not_configured',
      mainnetWritesEnabled: false,
    });
  });

  it('only reports mainnetWritesEnabled when a merchant capability is configured AND it targets mainnet', async () => {
    const baseDeps = {
      capabilityProvider: {
        async getShipyardMerchantCapability() {
          return null;
        },
      },
      quoteEngine: new QuoteEngine({
        pricingStatus: 'HYPOTHESIS',
        feeRateBps: 500,
        mandatoryToolBudgetAtomic: '1',
        dynamicToolBudgetAtomic: '1',
        modelInfrastructureReserveAtomic: '1',
        chainStorageReserveAtomic: '1',
        riskSupportReserveAtomic: '1',
        quoteTtlSeconds: 60,
      }),
      quoteRepository: new InMemoryQuoteRepository(),
      runRepository: new InMemoryRunRepository(),
    };

    const testnetConfiguredApp = createApp({
      ...baseDeps,
      runtimeStatusProvider: {
        async getRuntimeStatus() {
          return {
            status: 'ok',
            environment: 'development',
            persistence: 'postgresql',
            database: 'connected',
            merchantPayments: 'configured',
            mainnetWritesEnabled: false,
          };
        },
      },
    });
    apps.push(testnetConfiguredApp);
    const testnetResponse = await testnetConfiguredApp.inject({ method: 'GET', url: '/health' });
    expect(testnetResponse.json().mainnetWritesEnabled).toBe(false);

    const mainnetConfiguredApp = createApp({
      ...baseDeps,
      runtimeStatusProvider: {
        async getRuntimeStatus() {
          return {
            status: 'ok',
            environment: 'development',
            persistence: 'postgresql',
            database: 'connected',
            merchantPayments: 'configured',
            mainnetWritesEnabled: true,
          };
        },
      },
    });
    apps.push(mainnetConfiguredApp);
    const mainnetResponse = await mainnetConfiguredApp.inject({ method: 'GET', url: '/health' });
    expect(mainnetResponse.json().mainnetWritesEnabled).toBe(true);
  });

  describe('session authentication', () => {
    it('issues a session token for a fresh, correctly signed login', async () => {
      const app = testApp();
      const issuedAt = NOW_EPOCH;
      const signature = await privateKeyToAccount(requesterKey).signMessage({
        message: loginMessage(requesterAddress, issuedAt),
      });
      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/session',
        payload: { address: requesterAddress, signature, issuedAt },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ token: expect.any(String) });
    });

    it('refuses to issue a token for a signature that does not recover to the claimed address', async () => {
      const app = testApp();
      const impostorKey = `0x${'66'.repeat(32)}` as const;
      const issuedAt = NOW_EPOCH;
      const signature = await privateKeyToAccount(impostorKey).signMessage({
        message: loginMessage(requesterAddress, issuedAt),
      });
      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/session',
        payload: { address: requesterAddress, signature, issuedAt },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ code: 'LOGIN_SIGNATURE_INVALID' });
    });

    it('rate-limits repeated login attempts against the same instance', async () => {
      const app = testApp();
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const response = await app.inject({ method: 'POST', url: '/v1/auth/session', payload: {} });
        expect(response.statusCode).not.toBe(429);
      }
      const limited = await app.inject({ method: 'POST', url: '/v1/auth/session', payload: {} });
      expect(limited.statusCode).toBe(429);
      expect(limited.json()).toMatchObject({ code: 'RATE_LIMITED' });
    });

    it('fails closed on every protected route when auth is not configured', async () => {
      const app = testApp(true, { sessionSecret: undefined });
      const response = await app.inject({
        method: 'GET',
        url: `/v1/runs?requester=${requesterAddress}`,
        headers: requesterAuth,
      });
      expect(response.statusCode).toBe(503);
      expect(response.json().code).toBe('AUTH_NOT_CONFIGURED');
    });

    it('rejects a protected route with no bearer token at all', async () => {
      const app = testApp();
      const response = await app.inject({ method: 'GET', url: `/v1/runs?requester=${requesterAddress}` });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ code: 'AUTH_REQUIRED' });
    });

    it("rejects a caller listing another address's runs even while correctly authenticated as themselves", async () => {
      const app = testApp();
      const someoneElse = `0x${'9'.repeat(39)}a`;
      const response = await app.inject({
        method: 'GET',
        url: `/v1/runs?requester=${someoneElse}`,
        headers: requesterAuth,
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ code: 'REQUESTER_ADDRESS_MISMATCH' });
    });

    it('rejects requesting a quote as an address the caller did not authenticate as', async () => {
      const app = testApp();
      const someoneElse = `0x${'9'.repeat(39)}a`;
      const response = await app.inject({
        method: 'POST',
        url: '/v1/quotes',
        payload: { ...quoteBody, requesterAddress: someoneElse },
        headers: requesterAuth,
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ code: 'REQUESTER_ADDRESS_MISMATCH' });
    });

    it("treats another caller's run as not found rather than confirming it exists", async () => {
      const app = testApp();
      const runId = await createOwnedRun(app, 'ownership-test-0001');

      const outsiderKey = `0x${'77'.repeat(32)}` as const;
      const outsiderAddress = privateKeyToAccount(outsiderKey).address;
      const response = await app.inject({
        method: 'GET',
        url: `/v1/runs/${runId}`,
        headers: authHeaderFor(outsiderAddress),
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ code: 'RUN_NOT_FOUND' });
    });

    it('rejects an unauthenticated onboarding request', async () => {
      const app = testApp();
      const response = await app.inject({
        method: 'POST',
        url: '/v1/services/onboard',
        payload: {
          organizationName: 'Acme',
          requesterAddress,
          externalServiceId: 'service:acme',
          serviceName: 'Acme API',
          x402Endpoint: 'https://acme.example/paid',
          openApiUrl: 'https://acme.example/openapi.json',
          version: '1.0.0',
        },
      });
      expect(response.statusCode).toBe(401);
    });

    it('rejects onboarding as an address the caller did not authenticate as', async () => {
      const app = testApp();
      const someoneElse = `0x${'9'.repeat(39)}a`;
      const response = await app.inject({
        method: 'POST',
        url: '/v1/services/onboard',
        headers: requesterAuth,
        payload: {
          organizationName: 'Acme',
          requesterAddress: someoneElse,
          externalServiceId: 'service:acme',
          serviceName: 'Acme API',
          x402Endpoint: 'https://acme.example/paid',
          openApiUrl: 'https://acme.example/openapi.json',
          version: '1.0.0',
        },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ code: 'REQUESTER_ADDRESS_MISMATCH' });
    });
  });

  it('fails closed instead of inventing a payment capability', async () => {
    const response = await testApp(false).inject({
      method: 'POST',
      url: '/v1/quotes',
      payload: quoteBody,
      headers: requesterAuth,
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().code).toBe('RUNTIME_PAYMENT_CAPABILITY_UNAVAILABLE');
  });

  it('creates a transparent quote from a verified runtime capability', async () => {
    const response = await testApp().inject({
      method: 'POST',
      url: '/v1/quotes',
      payload: quoteBody,
      headers: requesterAuth,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      pricingStatus: 'HYPOTHESIS',
      totalAtomicAmount: '1421052',
      nextAction: 'CREATE_GOAT_FLOW_ERC20_DIRECT_ORDER',
    });
  });

  it('creates one QUOTED run for repeated idempotent requests without faking payment', async () => {
    const app = testApp();
    const quoteResponse = await app.inject({
      method: 'POST',
      url: '/v1/quotes',
      payload: quoteBody,
      headers: requesterAuth,
    });
    const quoteId = quoteResponse.json().id as string;
    const payload = { quoteId, idempotencyKey: 'customer-request-00000001' };

    const first = await app.inject({ method: 'POST', url: '/v1/runs', payload, headers: requesterAuth });
    const replay = await app.inject({ method: 'POST', url: '/v1/runs', payload, headers: requesterAuth });
    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(200);
    expect(first.json().run).toEqual(replay.json().run);
    expect(first.json()).toMatchObject({
      run: { status: 'QUOTED', revision: 1 },
      payment: { status: 'NOT_CREATED' },
    });
  });

  it('rejects reusing the same idempotency key against a different quote instead of returning the wrong run', async () => {
    let quoteCounter = 0;
    const app = createApp({
      capabilityProvider: {
        async getShipyardMerchantCapability() {
          return capability;
        },
      },
      quoteEngine: new QuoteEngine(
        {
          pricingStatus: 'HYPOTHESIS',
          feeRateBps: 500,
          mandatoryToolBudgetAtomic: '800000',
          dynamicToolBudgetAtomic: '300000',
          modelInfrastructureReserveAtomic: '100000',
          chainStorageReserveAtomic: '50000',
          riskSupportReserveAtomic: '100000',
          quoteTtlSeconds: 900,
        },
        () => `quote-fixed-${quoteCounter++}`,
      ),
      quoteRepository: new InMemoryQuoteRepository(),
      runRepository: new InMemoryRunRepository(),
      now: () => NOW,
      idFactory: () => 'run-fixed',
      merchantAdapter,
      sessionSecret: TEST_SESSION_SECRET,
    });
    apps.push(app);

    const firstQuote = await app.inject({
      method: 'POST',
      url: '/v1/quotes',
      payload: quoteBody,
      headers: requesterAuth,
    });
    const firstQuoteId = firstQuote.json().id as string;
    const secondQuote = await app.inject({
      method: 'POST',
      url: '/v1/quotes',
      payload: quoteBody,
      headers: requesterAuth,
    });
    const secondQuoteId = secondQuote.json().id as string;
    expect(firstQuoteId).not.toBe(secondQuoteId);

    const idempotencyKey = 'customer-request-reused-key-01';
    const first = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      payload: { quoteId: firstQuoteId, idempotencyKey },
      headers: requesterAuth,
    });
    expect(first.statusCode).toBe(201);

    const reused = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      payload: { quoteId: secondQuoteId, idempotencyKey },
      headers: requesterAuth,
    });
    expect(reused.statusCode).toBe(409);
    expect(reused.json()).toEqual({ code: 'IDEMPOTENCY_KEY_QUOTE_MISMATCH' });
  });

  it('returns one real adapter-backed x402 challenge and moves the run to PAYMENT_REQUIRED', async () => {
    const app = testApp();
    const runId = await createOwnedRun(app, 'payment-challenge-request-0001');

    const first = await app.inject({
      method: 'POST',
      url: `/v1/runs/${runId}/payment-challenge`,
      headers: requesterAuth,
    });
    const replay = await app.inject({
      method: 'POST',
      url: `/v1/runs/${runId}/payment-challenge`,
      headers: requesterAuth,
    });
    expect(first.statusCode).toBe(402);
    expect(replay.statusCode).toBe(402);
    expect(first.json()).toEqual(replay.json());
    expect(first.json()).toMatchObject({
      run: { status: 'PAYMENT_REQUIRED', revision: 2 },
      payment: {
        status: 'CHECKOUT_VERIFIED',
        orderId: 'flow-order-fixed',
        nextAction: 'PAY_X402_CHALLENGE',
        paymentRequired: { accepts: [{ network: 'eip155:2345' }] },
      },
    });
    const read = await app.inject({ method: 'GET', url: `/v1/runs/${runId}`, headers: requesterAuth });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual(first.json());
  });

  it('recovers an order persisted before the PAYMENT_REQUIRED transition', async () => {
    const runRepository = new InMemoryRunRepository();
    const app = testApp(true, { runRepository });
    const runId = await createOwnedRun(app, 'orphaned-payment-order-0001');
    const record = await runRepository.findById(runId);
    expect(record).not.toBeNull();
    const quote = (
      await app.inject({ method: 'POST', url: '/v1/quotes', payload: quoteBody, headers: requesterAuth })
    ).json();
    const paymentOrder = await merchantAdapter.createOrder({
      dappOrderId: runId,
      payerAddress: quoteBody.requesterAddress,
      atomicAmount: quote.totalAtomicAmount,
      capability,
    });
    await runRepository.save({ ...record!, paymentOrder }, record!.aggregate.revision);

    const recovered = await app.inject({
      method: 'POST',
      url: `/v1/runs/${runId}/payment-challenge`,
      headers: requesterAuth,
    });
    expect(recovered.statusCode).toBe(402);
    expect(recovered.json()).toMatchObject({
      run: { status: 'PAYMENT_REQUIRED', revision: 2 },
      payment: { orderId: 'flow-order-fixed', nextAction: 'PAY_X402_CHALLENGE' },
    });
  });

  it('never leaks a raw internal error message to the caller', async () => {
    const runRepository: RunRepository = {
      async save() {},
      async findByRequestIdempotencyKey() {
        return null;
      },
      async findById(): Promise<never> {
        throw new Error('connection to postgresql://shipyard:shipyard@10.0.0.5/shipyard failed');
      },
      async listByRequester() {
        return { runs: [], hasMore: false };
      },
    };
    const app = testApp(true, { runRepository });
    const response = await app.inject({ method: 'GET', url: '/v1/runs/run_missing', headers: requesterAuth });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ code: 'INTERNAL_ERROR', message: 'An internal error occurred.' });
    expect(response.body).not.toContain('postgresql://');
  });

  it('fails closed on the evidence route when no evidence store is configured', async () => {
    const app = testApp();
    const runId = await createOwnedRun(app, 'evidence-unconfigured-0001');
    const response = await app.inject({ method: 'GET', url: `/v1/runs/${runId}/evidence`, headers: requesterAuth });
    expect(response.statusCode).toBe(503);
    expect(response.json().code).toBe('EVIDENCE_PACK_PROVIDER_UNAVAILABLE');
  });

  it('returns 404 for a run with no built evidence pack yet', async () => {
    const app = testApp(true, {
      evidencePackProvider: {
        async getByRunId() {
          return null;
        },
      },
    });
    const runId = await createOwnedRun(app, 'evidence-not-built-0001');
    const response = await app.inject({ method: 'GET', url: `/v1/runs/${runId}/evidence`, headers: requesterAuth });
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe('EVIDENCE_PACK_NOT_FOUND');
  });

  it("serves a stored evidence pack to the run's own owner", async () => {
    const app = testApp(true, {
      evidencePackProvider: {
        async getByRunId(runId) {
          return {
            runId,
            evidenceRoot: `0x${'aa'.repeat(32)}`,
            toolReceiptRoot: `0x${'bb'.repeat(32)}`,
            uri: 'ipfs://bafkfaketest',
            contentHash: `0x${'cc'.repeat(32)}`,
            publicManifest: { scenarios: ['payment-proof-replay'], result: 'PASS' },
            builtAt: '2026-08-05T00:00:00.000Z',
          };
        },
      },
    });
    const runId = await createOwnedRun(app, 'evidence-served-0001');
    const response = await app.inject({ method: 'GET', url: `/v1/runs/${runId}/evidence`, headers: requesterAuth });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ runId, contentHash: `0x${'cc'.repeat(32)}` });
  });

  it('fails closed on the attestation route when no attestation store is configured', async () => {
    const app = testApp();
    const runId = await createOwnedRun(app, 'attestation-unconfigured-0001');
    const response = await app.inject({ method: 'GET', url: `/v1/runs/${runId}/attestation`, headers: requesterAuth });
    expect(response.statusCode).toBe(503);
    expect(response.json().code).toBe('ATTESTATION_PROVIDER_UNAVAILABLE');
  });

  it('returns 404 for a run with no attestation yet', async () => {
    const app = testApp(true, {
      attestationProvider: {
        async getByRunId() {
          return null;
        },
      },
    });
    const runId = await createOwnedRun(app, 'attestation-not-built-0001');
    const response = await app.inject({ method: 'GET', url: `/v1/runs/${runId}/attestation`, headers: requesterAuth });
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe('ATTESTATION_NOT_FOUND');
  });

  it("serves a stored attestation to the run's own owner", async () => {
    const app = testApp(true, {
      attestationProvider: {
        async getByRunId(runId) {
          return {
            runId,
            registryAddress: '0x07f6a55Fb88DD29e9A10802ce8d706dA26db8ddd',
            chainId: 48816,
            transactionHash: `0x${'dd'.repeat(32)}`,
            attestor: '0x8eb7E837242d6eE3Baa274F1750C644bF3E08c10',
            expiresAt: '2026-09-04T00:00:00.000Z',
            submittedAt: '2026-08-05T00:00:00.000Z',
          };
        },
      },
    });
    const runId = await createOwnedRun(app, 'attestation-served-0001');
    const response = await app.inject({ method: 'GET', url: `/v1/runs/${runId}/attestation`, headers: requesterAuth });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ runId, transactionHash: `0x${'dd'.repeat(32)}` });
  });
});
