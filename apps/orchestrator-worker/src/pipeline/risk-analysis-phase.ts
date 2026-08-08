import type { OrchestratorRunCheckpoint } from '@shipyard402/persistence-postgres';
import type { Quote } from '@shipyard402/quote-engine';
import { compileTestPlan, type CompiledTestPlan, type RiskClassification } from '@shipyard402/risk-classifier';

import { SCENARIO_EXECUTORS } from './scenarios.js';
import type { OrchestratorPipelineDependencies } from './types.js';

/** ANALYZING: classify risk and compile the deterministic test plan, checkpointed together since compileTestPlan is derived solely from the classifier's proposal. */
export async function runRiskAnalysisPhase(
  deps: OrchestratorPipelineDependencies,
  runId: string,
  checkpoint: OrchestratorRunCheckpoint,
  quote: Quote,
  targetVersionHash: `0x${string}`,
): Promise<Readonly<{ plan: CompiledTestPlan; proposal: RiskClassification | undefined }>> {
  let plan = checkpoint.plan as CompiledTestPlan | undefined;
  let proposal = checkpoint.proposal as RiskClassification | undefined;
  if (!plan) {
    proposal = await deps.riskClassifier.classify({
      targetServiceId: quote.request.targetServiceId,
      targetVersionHash,
      x402Endpoint: quote.request.x402Endpoint,
      openApiUrl: quote.request.openApiUrl,
      serviceSummary: `Controlled demo x402 paid resource used to prove payment-proof replay handling for ${quote.request.targetServiceId}.`,
      mandatoryScenarios: deps.mandatoryScenarios,
      availableScenarios: Object.keys(SCENARIO_EXECUTORS),
      maximumToolBudgetAtomic: quote.refundableToolBudgetAtomic,
    });
    plan = compileTestPlan(proposal, deps.mandatoryScenarios, quote.refundableToolBudgetAtomic);
    // proposal is kept only for the evidence pack's transparency fields (see AiRiskProposal) --
    // plan above is the sole authority the rest of this pipeline ever reads from.
    await deps.checkpointStore.merge(runId, { plan, proposal });
  }
  return { plan, proposal };
}
