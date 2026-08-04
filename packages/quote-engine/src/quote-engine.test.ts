import { describe, expect, it } from 'vitest';

import { QuoteBudgetExceededError, QuoteEngine } from './quote-engine.js';

const engine = new QuoteEngine(
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
  () => 'fixed-id',
);

const request = {
  organizationId: '7d575e3d-a625-4b71-a28b-86dc202d1d7f',
  requesterAddress: '0x2000000000000000000000000000000000000002',
  targetAgentId: 'agent:184',
  targetServiceId: 'service:market-signal',
  targetVersionHash: `0x${'11'.repeat(32)}`,
  policyHash: `0x${'22'.repeat(32)}`,
  x402Endpoint: 'https://target.example/api/paid',
  openApiUrl: 'https://target.example/openapi.json',
  maximumCustomerBudgetAtomic: '6000000',
} as const;

const capability = {
  environment: 'mainnet',
  merchantId: 'shipyard',
  mode: 'ERC20_DIRECT',
  chainId: 2345,
  tokenAddress: '0x1000000000000000000000000000000000000001',
  tokenSymbol: 'RUNTIME_ASSET',
  tokenDecimals: 6,
  receivingAddress: '0x3000000000000000000000000000000000000003',
  minimumAtomicAmount: '1',
  maximumAtomicAmount: '100000000',
  discoveredAt: '2026-08-04T10:00:00.000Z',
  source: 'AUTHENTICATED_API',
} as const;

describe('quote engine', () => {
  it('produces a transparent hypothesis quote and commitment', () => {
    const quote = engine.createQuote(request, capability, new Date('2026-08-04T10:00:00.000Z'));
    expect(quote.totalAtomicAmount).toBe('4700000');
    expect(quote.refundableToolBudgetAtomic).toBe('1800000');
    expect(quote.pricingStatus).toBe('HYPOTHESIS');
    expect(quote.quoteCommitment).toMatch(/^0x[a-f0-9]{64}$/);
  });

  it('refuses to exceed the customer hard maximum', () => {
    expect(() =>
      engine.createQuote(
        { ...request, maximumCustomerBudgetAtomic: '4699999' },
        capability,
        new Date('2026-08-04T10:00:00.000Z'),
      ),
    ).toThrow(QuoteBudgetExceededError);
  });
});
