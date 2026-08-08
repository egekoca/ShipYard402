import type { OrchestratorRunCheckpoint } from '@shipyard402/persistence-postgres';
import type { Quote } from '@shipyard402/quote-engine';
import type { CompiledTestPlan } from '@shipyard402/risk-classifier';

import { SCENARIO_EXECUTORS, verifyScenarioProvenance } from './scenarios.js';
import type { OrchestratorPipelineDependencies, ScenarioExecutionContext, ScenarioResult } from './types.js';

/** EXECUTING: run every scenario in the compiled plan once, checkpointed as a batch since each probe consumes something spend-once (e.g. the replay check spends the receipt). */
export async function runExecutionPhase(
  deps: OrchestratorPipelineDependencies,
  runId: string,
  checkpoint: OrchestratorRunCheckpoint,
  plan: CompiledTestPlan,
  quote: Quote,
  targetVersionHash: `0x${string}`,
  policyHash: `0x${string}`,
  purchaseReceipt: string,
  paymentTransactionHash: `0x${string}`,
  now: () => Date,
): Promise<Readonly<{ scenarioResults: readonly ScenarioResult[]; startedAt: number; completedAt: number }>> {
  let scenarioResults = checkpoint.evidence as readonly ScenarioResult[] | undefined;
  let startedAt = checkpoint.startedAt;
  let completedAt = checkpoint.completedAt;
  if (!scenarioResults || startedAt === undefined || completedAt === undefined) {
    startedAt = Math.floor(now().getTime() / 1_000);
    const context: ScenarioExecutionContext = {
      targetServiceId: quote.request.targetServiceId,
      targetVersionHash,
      policyHash,
      paymentReceipt: purchaseReceipt,
      paymentTransactionHash,
      deliveryClient: deps.deliveryClient,
    };
    const results: ScenarioResult[] = [];
    for (const scenarioId of plan.scenarios) {
      const executor = SCENARIO_EXECUTORS[scenarioId];
      if (!executor) continue;
      results.push(await executor(context));
    }
    if (results.length === 0) throw new Error('No scenario in the compiled plan has a registered executor');
    scenarioResults = results;
    completedAt = Math.floor(now().getTime() / 1_000);
    await deps.checkpointStore.merge(runId, { evidence: scenarioResults, startedAt, completedAt });
  }
  scenarioResults = verifyScenarioProvenance(scenarioResults, deps.demoTarget.providerSignerAddress);
  return { scenarioResults, startedAt, completedAt };
}
