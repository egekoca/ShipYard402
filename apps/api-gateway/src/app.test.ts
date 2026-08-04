import { QuoteEngine } from '@shipyard402/quote-engine';
import type { X402MerchantAdapter } from '@shipyard402/x402-payments';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { InMemoryQuoteRepository, InMemoryRunRepository } from './repositories.js';

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
  requesterAddress: '0x2000000000000000000000000000000000000002',
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
  async discoverRuntimeCapabilities() { return [capability]; },
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
        accepts: [{
          scheme: 'exact', network: 'eip155:2345', amount: input.atomicAmount,
          asset: capability.tokenAddress, payTo: capability.receivingAddress, maxTimeoutSeconds: 900,
        }],
      },
    };
  },
  async getOrderStatus() { throw new Error('Not used in API tests'); },
  async getOrderProof() { throw new Error('Not used in API tests'); },
};

function testApp(withCapability = true): ReturnType<typeof createApp> {
  const app = createApp({
    capabilityProvider: {
      async getShipyardMerchantCapability() {
        return withCapability ? capability : null;
      },
    },
    quoteEngine: new QuoteEngine(
      {
        pricingStatus: 'HYPOTHESIS',
        baseOrchestrationFeeAtomic: '2000000',
        mandatoryToolBudgetAtomic: '1200000',
        dynamicToolBudgetAtomic: '600000',
        modelInfrastructureReserveAtomic: '350000',
        chainStorageReserveAtomic: '150000',
        riskSupportReserveAtomic: '400000',
        quoteTtlSeconds: 900,
      },
      () => 'quote-fixed',
    ),
    quoteRepository: new InMemoryQuoteRepository(),
    runRepository: new InMemoryRunRepository(),
    now: () => new Date('2026-08-04T10:00:00.000Z'),
    idFactory: () => 'run-fixed',
    merchantAdapter,
  });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('api gateway vertical slice', () => {
  it('fails closed instead of inventing a payment capability', async () => {
    const response = await testApp(false).inject({ method: 'POST', url: '/v1/quotes', payload: quoteBody });
    expect(response.statusCode).toBe(503);
    expect(response.json().code).toBe('RUNTIME_PAYMENT_CAPABILITY_UNAVAILABLE');
  });

  it('creates a transparent quote from a verified runtime capability', async () => {
    const response = await testApp().inject({ method: 'POST', url: '/v1/quotes', payload: quoteBody });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      pricingStatus: 'HYPOTHESIS',
      totalAtomicAmount: '4700000',
      nextAction: 'CREATE_GOAT_FLOW_ERC20_DIRECT_ORDER',
    });
  });

  it('creates one QUOTED run for repeated idempotent requests without faking payment', async () => {
    const app = testApp();
    const quoteResponse = await app.inject({ method: 'POST', url: '/v1/quotes', payload: quoteBody });
    const quoteId = quoteResponse.json().id as string;
    const payload = { quoteId, idempotencyKey: 'customer-request-00000001' };

    const first = await app.inject({ method: 'POST', url: '/v1/runs', payload });
    const replay = await app.inject({ method: 'POST', url: '/v1/runs', payload });
    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(200);
    expect(first.json().run).toEqual(replay.json().run);
    expect(first.json()).toMatchObject({
      run: { status: 'QUOTED', revision: 1 },
      payment: { status: 'NOT_CREATED' },
    });
  });

  it('returns one real adapter-backed x402 challenge and moves the run to PAYMENT_REQUIRED', async () => {
    const app = testApp();
    const quoteResponse = await app.inject({ method: 'POST', url: '/v1/quotes', payload: quoteBody });
    const runResponse = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      payload: { quoteId: quoteResponse.json().id, idempotencyKey: 'payment-challenge-request-0001' },
    });
    const runId = runResponse.json().run.id as string;

    const first = await app.inject({ method: 'POST', url: `/v1/runs/${runId}/payment-challenge` });
    const replay = await app.inject({ method: 'POST', url: `/v1/runs/${runId}/payment-challenge` });
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
    const read = await app.inject({ method: 'GET', url: `/v1/runs/${runId}` });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual(first.json());
  });
});
