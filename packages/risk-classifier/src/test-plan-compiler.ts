import type { RiskClassification } from './ports.js';

export type CompiledTestPlan = Readonly<{
  scenarios: readonly string[];
  toolBudgetAtomic: string;
  riskLevel: RiskClassification['riskLevel'];
  rationale: string;
}>;

/**
 * The AI's proposal is advisory only (ADR-0006): mandatory scenarios always run regardless
 * of what it proposed, and its proposed budget is clamped to the mandate ceiling, never trusted
 * as-is. A malformed or adversarial AI response can only ever narrow, never widen, what runs.
 */
export function compileTestPlan(
  proposal: RiskClassification,
  mandatoryScenarios: readonly string[],
  maximumToolBudgetAtomic: string,
): CompiledTestPlan {
  if (mandatoryScenarios.length === 0) throw new Error('At least one mandatory scenario is required');

  const scenarios = [...new Set([...mandatoryScenarios, ...proposal.proposedScenarios])];
  const proposedBudget = BigInt(proposal.proposedToolBudgetAtomic);
  const ceiling = BigInt(maximumToolBudgetAtomic);
  const toolBudgetAtomic = (proposedBudget > ceiling ? ceiling : proposedBudget).toString();

  return {
    scenarios,
    toolBudgetAtomic,
    riskLevel: proposal.riskLevel,
    rationale: proposal.rationale,
  };
}
