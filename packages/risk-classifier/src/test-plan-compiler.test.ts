import { describe, expect, it } from 'vitest';

import type { RiskClassification } from './ports.js';
import { compileTestPlan } from './test-plan-compiler.js';

const baseProposal: RiskClassification = {
  riskLevel: 'MEDIUM',
  proposedScenarios: ['schema-drift'],
  proposedToolBudgetAtomic: '500000',
  rationale: 'test',
};

describe('compileTestPlan', () => {
  it('always includes mandatory scenarios even if the AI omits them', () => {
    const plan = compileTestPlan(baseProposal, ['payment-proof-replay'], '1000000');
    expect(plan.scenarios).toContain('payment-proof-replay');
    expect(plan.scenarios).toContain('schema-drift');
  });

  it('deduplicates scenarios proposed twice', () => {
    const proposal: RiskClassification = { ...baseProposal, proposedScenarios: ['payment-proof-replay'] };
    const plan = compileTestPlan(proposal, ['payment-proof-replay'], '1000000');
    expect(plan.scenarios).toEqual(['payment-proof-replay']);
  });

  it('clamps a proposed budget above the mandate ceiling', () => {
    const proposal: RiskClassification = { ...baseProposal, proposedToolBudgetAtomic: '999999999' };
    const plan = compileTestPlan(proposal, ['payment-proof-replay'], '1000000');
    expect(plan.toolBudgetAtomic).toBe('1000000');
  });

  it('keeps a proposed budget within the ceiling unchanged', () => {
    const plan = compileTestPlan(baseProposal, ['payment-proof-replay'], '1000000');
    expect(plan.toolBudgetAtomic).toBe('500000');
  });

  it('rejects an empty mandatory scenario list', () => {
    expect(() => compileTestPlan(baseProposal, [], '1000000')).toThrow();
  });
});
