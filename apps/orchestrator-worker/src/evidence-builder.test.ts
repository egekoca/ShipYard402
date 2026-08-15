import { EMPTY_TOOL_RECEIPT_ROOT } from '@shipyard402/evidence-sdk';
import { describe, expect, it } from 'vitest';

import { buildEvidencePack, canBuildToolReceipt, type EvidencePackContent } from './evidence-builder.js';

function pack(overrides: Partial<EvidencePackContent> = {}): EvidencePackContent {
  return {
    runId: 'run_test_1',
    targetServiceId: 'service:acme-api',
    targetVersionHash: `0x${'11'.repeat(32)}`,
    policyHash: `0x${'22'.repeat(32)}`,
    riskLevel: 'MEDIUM',
    rationale: 'test',
    toolBudgetAtomic: '150',
    scenarios: [],
    scenarioTraces: [],
    result: 'INCONCLUSIVE',
    toolReceipts: [],
    ...overrides,
  };
}

describe('buildEvidencePack', () => {
  it('builds a receipt-free pack for an INCONCLUSIVE run', () => {
    // A run finalized before any scenario ran has zero receipts. Refusing to build its pack would
    // leave a paying customer with no verdict at all, which is worse than an honest "unknown".
    const built = buildEvidencePack(pack());
    expect(built.publicManifest.result).toBe('INCONCLUSIVE');
    expect(built.toolReceiptRoot).toBe(EMPTY_TOOL_RECEIPT_ROOT);
  });

  it('refuses to build a PASS with nothing behind it', () => {
    expect(() => buildEvidencePack(pack({ result: 'PASS' }))).toThrow(/at least one tool receipt/);
  });

  it('refuses to build a FAIL with nothing behind it', () => {
    expect(() => buildEvidencePack(pack({ result: 'FAIL' }))).toThrow(/at least one tool receipt/);
  });

  it('marks the empty root as its own value, never the zero hash', () => {
    // The zero hash is indistinguishable from an unset field once it is on chain.
    expect(EMPTY_TOOL_RECEIPT_ROOT).not.toBe(`0x${'00'.repeat(32)}`);
    expect(EMPTY_TOOL_RECEIPT_ROOT).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe('canBuildToolReceipt', () => {
  it('accepts a scenario whose first attempt got a response back', () => {
    expect(
      canBuildToolReceipt({
        scenarioId: 'payment-proof-replay',
        result: 'PASS',
        attempts: [{ phase: 'INITIAL', requestHash: `0x${'11'.repeat(32)}`, responseHash: `0x${'33'.repeat(32)}` }],
      }),
    ).toBe(true);
  });

  it('rejects a scenario recorded before any response arrived', () => {
    expect(
      canBuildToolReceipt({
        scenarioId: 'payment-proof-replay',
        result: 'INCONCLUSIVE',
        attempts: [{ phase: 'INITIAL', requestHash: `0x${'11'.repeat(32)}` }],
      }),
    ).toBe(false);
  });

  it('rejects a scenario with no attempts at all', () => {
    expect(canBuildToolReceipt({ scenarioId: 'payment-proof-replay', result: 'INCONCLUSIVE', attempts: [] })).toBe(
      false,
    );
  });
});
