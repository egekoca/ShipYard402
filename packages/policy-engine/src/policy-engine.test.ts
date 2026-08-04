import { describe, expect, it } from 'vitest';

import { runMandateSchema } from './mandate.js';
import { authorizePurchase } from './purchase-authorization.js';

const mandate = runMandateSchema.parse({
  maximumTotalSpend: '1500000',
  maximumSinglePurchase: '600000',
  maximumToolCalls: 6,
  maximumRetriesPerTool: 1,
  allowedToolAgentIds: ['agent:tool:184', 'agent:tool:201'],
  allowedHosts: ['runner.example.com', 'receipt.example.com'],
  requiredScenarios: ['unpaid_request', 'successful_payment', 'protected_delivery', 'payment_replay'],
  additionalSpendApprovalThreshold: '1000000',
  deadline: 1_800_000_000,
});

const allowedIntent = {
  runId: 'run_001',
  toolAgentId: 'agent:tool:184',
  providerServiceId: 'replay-runner-v1',
  host: 'runner.example.com',
  atomicAmount: '500000',
  idempotencyKey: 'run_001:replay-runner:attempt:1',
} as const;

const baseContext = {
  nowEpochSeconds: 1_790_000_000,
  runStatus: 'PROCURING',
  currentTotalSpend: '0',
  completedToolCalls: 0,
  priorAttemptsForTool: 0,
  shipyardAgentId: 'agent:shipyard',
  shipyardControlledHosts: ['shipyard.example'],
  additionalSpendApproved: false,
} as const;

describe('policy-bound purchase authorization', () => {
  it('authorizes an allowlisted purchase within all hard limits', () => {
    const result = authorizePurchase(mandate, allowedIntent, baseContext);
    expect(result.authorized).toBe(true);
    expect(result.projectedTotalSpend).toBe('500000');
  });

  it('denies an arbitrary provider and private host', () => {
    const result = authorizePurchase(
      mandate,
      { ...allowedIntent, toolAgentId: 'attacker', host: '127.0.0.1' },
      baseContext,
    );
    expect(result.authorized).toBe(false);
    expect(result.denialCodes).toContain('TOOL_NOT_ALLOWED');
    expect(result.denialCodes).toContain('HOST_NOT_ALLOWED');
  });

  it('denies budget overflow even when the LLM requested it', () => {
    const result = authorizePurchase(
      mandate,
      { ...allowedIntent, atomicAmount: '600000' },
      { ...baseContext, currentTotalSpend: '1000000', additionalSpendApproved: true },
    );
    expect(result.authorized).toBe(false);
    expect(result.denialCodes).toContain('TOTAL_SPEND_LIMIT');
  });

  it('requires approval beyond the configured threshold', () => {
    const result = authorizePurchase(
      mandate,
      allowedIntent,
      { ...baseContext, currentTotalSpend: '600000' },
    );
    expect(result.authorized).toBe(false);
    expect(result.denialCodes).toContain('ADDITIONAL_APPROVAL_REQUIRED');
  });

  it('rejects localhost and private IPs in a mandate', () => {
    expect(() => runMandateSchema.parse({ ...mandate, allowedHosts: ['localhost'] })).toThrow();
    expect(() => runMandateSchema.parse({ ...mandate, allowedHosts: ['10.0.0.1'] })).toThrow();
  });

  it('blocks self-dealing providers and terminal-run spend', () => {
    const result = authorizePurchase(
      mandate,
      { ...allowedIntent, toolAgentId: 'agent:shipyard', host: 'shipyard.example' },
      {
        ...baseContext,
        runStatus: 'DELIVERED_FAIL',
        shipyardControlledHosts: ['shipyard.example'],
      },
    );
    expect(result.denialCodes).toEqual(
      expect.arrayContaining(['RUN_TERMINAL', 'TOOL_NOT_ALLOWED', 'SELF_DEALING_TOOL', 'SELF_DEALING_HOST']),
    );
  });
});
