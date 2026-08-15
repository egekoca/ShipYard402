import type { Quote } from '@shipyard402/quote-engine';
import type { CompiledTestPlan, RiskClassification } from '@shipyard402/risk-classifier';

import { buildEvidencePack, buildUnsignedToolReceipt, canonicalEvidencePackContent } from '../evidence-builder.js';
import { aggregateScenarioResult } from './scenarios.js';
import type { OrchestratorPipelineDependencies, ScenarioResult } from './types.js';

/** EVIDENCE_BUILDING: sign a tool receipt per scenario result, assemble the evidence pack, and publish + store it (content-addressed, so republishing on resume is naturally idempotent). */
export async function runEvidencePhase(
  deps: OrchestratorPipelineDependencies,
  runId: string,
  quote: Quote,
  targetVersionHash: `0x${string}`,
  policyHash: `0x${string}`,
  plan: CompiledTestPlan,
  proposal: RiskClassification | undefined,
  scenarioResults: readonly ScenarioResult[],
  startedAt: number,
  completedAt: number,
  now: () => Date,
  /**
   * Overrides the verdict derived from the scenario results. Used only by terminal-failure
   * finalization: a run that stopped early may carry a handful of passing scenarios, and letting
   * those aggregate to PASS would report full coverage the run never achieved.
   */
  forcedResult?: 'INCONCLUSIVE',
): Promise<
  Readonly<{
    evidencePack: ReturnType<typeof buildEvidencePack>;
    evidenceURI: string;
    overallResult: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
  }>
> {
  const toolReceipts: (ReturnType<typeof buildUnsignedToolReceipt> & { signature: `0x${string}` })[] = [];
  for (const scenarioResult of scenarioResults) {
    const unsignedReceipt = buildUnsignedToolReceipt(scenarioResult.evidence, {
      runId,
      toolAgentId: deps.demoTarget.toolAgentId,
      targetAgentId: quote.request.targetAgentId,
      targetVersionHash,
      policyHash,
      chainTransactionHash: scenarioResult.chainTransactionHash,
      chainId: deps.demoTarget.chainId,
      startedAt,
      completedAt,
      toolVersion: deps.demoTarget.toolVersion,
    });
    const signature = await deps.toolReceiptSigner.sign(unsignedReceipt);
    toolReceipts.push({ ...unsignedReceipt, signature });
  }
  const overallResult = forcedResult ?? aggregateScenarioResult(scenarioResults.map((result) => result.evidence));

  const evidencePack = buildEvidencePack({
    runId,
    targetServiceId: quote.request.targetServiceId,
    targetVersionHash,
    policyHash,
    riskLevel: plan.riskLevel,
    rationale: plan.rationale,
    toolBudgetAtomic: plan.toolBudgetAtomic,
    ...(proposal
      ? {
          aiProposal: {
            riskLevel: proposal.riskLevel,
            proposedScenarios: proposal.proposedScenarios,
            proposedToolBudgetAtomic: proposal.proposedToolBudgetAtomic,
            rationale: proposal.rationale,
          },
        }
      : {}),
    scenarios: scenarioResults.map((result) => result.evidence.scenarioId),
    scenarioTraces: scenarioResults.map((result) => ({
      scenarioId: result.evidence.scenarioId,
      attempts: result.evidence.attempts,
    })),
    result: overallResult,
    toolReceipts,
  });
  // Content-addressed and idempotent -- a resumed attempt republishing the same bytes gets the
  // same CID back, so this needs no checkpoint guard (unlike the payment and attestation sends).
  const evidenceURI = await deps.evidencePublisher.publish(canonicalEvidencePackContent(evidencePack.publicManifest));
  if (!(await deps.evidencePackStore.getByRunId(runId))) {
    await deps.evidencePackStore.put({
      runId,
      evidenceRoot: evidencePack.evidenceRoot,
      toolReceiptRoot: evidencePack.toolReceiptRoot,
      uri: evidenceURI,
      contentHash: evidencePack.contentHash,
      publicManifest: evidencePack.publicManifest,
      builtAt: now().toISOString(),
    });
  }

  return { evidencePack, evidenceURI, overallResult };
}
