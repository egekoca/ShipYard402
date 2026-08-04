import { runMandateSchema, type RunMandate } from '@shipyard402/policy-engine';
import type { CompiledTestPlan } from '@shipyard402/risk-classifier';

export type DemoTargetProcurementConfig = Readonly<{
  toolAgentId: string;
  host: string;
}>;

export function buildMandate(
  plan: CompiledTestPlan,
  demoTarget: DemoTargetProcurementConfig,
  deadlineEpochSeconds: number,
): RunMandate {
  return runMandateSchema.parse({
    maximumTotalSpend: plan.toolBudgetAtomic,
    maximumSinglePurchase: plan.toolBudgetAtomic,
    maximumToolCalls: 1,
    maximumRetriesPerTool: 0,
    allowedToolAgentIds: [demoTarget.toolAgentId],
    allowedHosts: [demoTarget.host],
    requiredScenarios: plan.scenarios,
    additionalSpendApprovalThreshold: plan.toolBudgetAtomic,
    deadline: deadlineEpochSeconds,
  });
}
