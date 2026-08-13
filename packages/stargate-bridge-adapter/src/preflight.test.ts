import { describe, expect, it } from 'vitest';

import { evaluateCrossChainPreflight, type PreflightFacts } from './preflight.js';

function facts(overrides: Partial<PreflightFacts> = {}): PreflightFacts {
  return {
    route: { sourcePoolLive: true, sourceTokenMatches: true, destinationPoolLive: true, destinationTokenMatches: true },
    goat: { signerAddress: '0x8eb7', usdcBalanceAtomic: '1000000', nativeGasWei: '100000000000000' },
    bridgeAmountAtomic: '250000',
    minGoatGasWei: '50000000000000',
    bnb: { configured: false },
    ...overrides,
  };
}

function statusOf(report: ReturnType<typeof evaluateCrossChainPreflight>, name: string) {
  return report.checks.find((c) => c.name.startsWith(name))?.status;
}

describe('evaluateCrossChainPreflight', () => {
  it('passes GOAT-side checks and skips BNB when cross-chain is unconfigured', () => {
    const report = evaluateCrossChainPreflight(facts());
    expect(report.ok).toBe(true);
    expect(statusOf(report, 'Stargate source')).toBe('pass');
    expect(statusOf(report, 'Stargate destination')).toBe('pass');
    expect(statusOf(report, 'GOAT signer USDC')).toBe('pass');
    expect(statusOf(report, 'BNB destination side')).toBe('skip');
  });

  it('fails when the GOAT USDC balance cannot cover the bridge amount', () => {
    const report = evaluateCrossChainPreflight(facts({ bridgeAmountAtomic: '2000000' }));
    expect(report.ok).toBe(false);
    expect(statusOf(report, 'GOAT signer USDC')).toBe('fail');
  });

  it('fails closed if a pool is live but its token() is not the expected USDC (address drift)', () => {
    const report = evaluateCrossChainPreflight(
      facts({
        route: {
          sourcePoolLive: true,
          sourceTokenMatches: false,
          destinationPoolLive: true,
          destinationTokenMatches: true,
        },
      }),
    );
    expect(report.ok).toBe(false);
    expect(statusOf(report, 'Stargate source')).toBe('fail');
  });

  it('warns (does not block) on thin GOAT gas, since the real fee is quoted at send time', () => {
    const report = evaluateCrossChainPreflight(
      facts({ goat: { signerAddress: '0x8eb7', usdcBalanceAtomic: '1000000', nativeGasWei: '1' } }),
    );
    expect(statusOf(report, 'GOAT signer native')).toBe('warn');
    expect(report.ok).toBe(true);
  });

  it('checks the BNB endpoint returns a 402 and the target amount is within its ceiling', () => {
    const report = evaluateCrossChainPreflight(
      facts({
        bnb: {
          configured: true,
          payerAddress: '0xbnb',
          nativeGasWei: '5000000000000000',
          minGasWei: '1000000000000000',
          endpointReachable: true,
          endpointStatus: 402,
          targetAmountAtomic: '200000000000000000',
          maxTargetAmountAtomic: '1000000000000000000',
        },
      }),
    );
    expect(report.ok).toBe(true);
    expect(statusOf(report, 'BNB x402 target')).toBe('pass');
    expect(statusOf(report, 'BNB target payment')).toBe('pass');
  });

  it('fails when the BNB endpoint does not answer a 402', () => {
    const report = evaluateCrossChainPreflight(
      facts({
        bnb: { configured: true, endpointReachable: true, endpointStatus: 200 },
      }),
    );
    expect(report.ok).toBe(false);
    expect(statusOf(report, 'BNB x402 target')).toBe('fail');
  });
});
