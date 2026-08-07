import { describe, expect, it } from 'vitest';

import { QuoteBudgetExceededError, QuoteEngine } from './quote-engine.js';

const engine = new QuoteEngine(
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
    expect(quote.lineItems.baseOrchestrationFeeAtomic).toBe('71052');
    expect(quote.totalAtomicAmount).toBe('1421052');
    expect(quote.refundableToolBudgetAtomic).toBe('1100000');
    expect(quote.pricingStatus).toBe('HYPOTHESIS');
    expect(quote.quoteCommitment).toMatch(/^0x[a-f0-9]{64}$/);
  });

  it('prices the orchestration fee as a take rate, not a flat amount', () => {
    const quote = engine.createQuote(request, capability, new Date('2026-08-04T10:00:00.000Z'));
    const fee = BigInt(quote.lineItems.baseOrchestrationFeeAtomic);
    const total = BigInt(quote.totalAtomicAmount);
    // Integer division floors, so the ratio lands just under the nominal 500 bps, never over.
    const bps = Number((fee * 10_000n) / total);
    expect(bps).toBeLessThanOrEqual(500);
    expect(bps).toBeGreaterThan(495);

    const doubledCosts = new QuoteEngine(
      {
        pricingStatus: 'HYPOTHESIS',
        feeRateBps: 500,
        mandatoryToolBudgetAtomic: '1600000',
        dynamicToolBudgetAtomic: '600000',
        modelInfrastructureReserveAtomic: '200000',
        chainStorageReserveAtomic: '100000',
        riskSupportReserveAtomic: '200000',
        quoteTtlSeconds: 900,
      },
      () => 'fixed-id',
    );
    const doubledQuote = doubledCosts.createQuote(request, capability, new Date('2026-08-04T10:00:00.000Z'));
    // Doubling every pass-through cost must roughly double the fee too (off by at most integer
    // floor-rounding on each side) -- a flat fee would have stayed exactly put instead.
    const doubledFee = BigInt(doubledQuote.lineItems.baseOrchestrationFeeAtomic);
    expect(doubledFee - fee * 2n).toBeGreaterThanOrEqual(-1n);
    expect(doubledFee - fee * 2n).toBeLessThanOrEqual(1n);
  });

  it('rejects a fee rate outside (0, 10000) basis points', () => {
    expect(() => new QuoteEngine({
      pricingStatus: 'HYPOTHESIS',
      feeRateBps: 0,
      mandatoryToolBudgetAtomic: '1',
      dynamicToolBudgetAtomic: '1',
      modelInfrastructureReserveAtomic: '1',
      chainStorageReserveAtomic: '1',
      riskSupportReserveAtomic: '1',
      quoteTtlSeconds: 900,
    })).toThrow('Fee rate must be an integer number of basis points strictly between 0 and 10000');
  });

  it('refuses to exceed the customer hard maximum', () => {
    expect(() =>
      engine.createQuote(
        { ...request, maximumCustomerBudgetAtomic: '1421051' },
        capability,
        new Date('2026-08-04T10:00:00.000Z'),
      ),
    ).toThrow(QuoteBudgetExceededError);
  });
});
