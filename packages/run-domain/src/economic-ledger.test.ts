import { describe, expect, it } from 'vitest';

import { calculateRunEconomics, type LedgerEntry } from './economic-ledger.js';

const asset = {
  chainId: 2345,
  tokenAddress: '0x1000000000000000000000000000000000000001',
  decimals: 6,
} as const;

const entry = (
  id: string,
  category: LedgerEntry['category'],
  accountingValueMicros: string,
): LedgerEntry => ({
  id,
  runId: 'run_001',
  category,
  asset,
  atomicAmount: accountingValueMicros,
  accountingCurrency: 'USD',
  accountingValueMicros,
  occurredAt: '2026-08-04T10:00:00.000Z',
});

describe('economic ledger', () => {
  it('keeps customer revenue and costs separate and computes contribution', () => {
    const economics = calculateRunEconomics([
      entry('1', 'CUSTOMER_PAYMENT', '5000000'),
      entry('2', 'TOOL_SPEND', '1800000'),
      entry('3', 'MODEL_COST', '350000'),
      entry('4', 'CHAIN_COST', '150000'),
      entry('5', 'STORAGE_COST', '50000'),
    ]);
    expect(economics).toMatchObject({
      customerRevenueMicros: '5000000',
      toolCostMicros: '1800000',
      grossContributionMicros: '2650000',
    });
  });

  it('refuses to invent cross-asset fiat valuation', () => {
    expect(() =>
      calculateRunEconomics([
        {
          ...entry('1', 'CUSTOMER_PAYMENT', '5000000'),
          accountingCurrency: undefined,
          accountingValueMicros: undefined,
        },
      ]),
    ).toThrow('explicit USD micro valuation');
  });
});
