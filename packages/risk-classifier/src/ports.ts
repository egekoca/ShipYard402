import { z } from 'zod';

const scenarioIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_.-]{1,127}$/);
const atomicAmountSchema = z.string().regex(/^(0|[1-9]\d*)$/);

export const riskClassificationSchema = z
  .object({
    riskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH']),
    proposedScenarios: z.array(scenarioIdSchema).min(1).max(20),
    proposedToolBudgetAtomic: atomicAmountSchema,
    rationale: z.string().min(1).max(2000),
  })
  .strict();

export type RiskClassification = z.infer<typeof riskClassificationSchema>;

/**
 * Deterministic code already knows the target — this is a fixed summary, not a live fetch.
 * Keeping the AI's only network access as the OpenAI call itself matches ADR-0006: no
 * arbitrary HTTP capability for the AI layer.
 */
export type RiskClassificationInput = Readonly<{
  targetServiceId: string;
  targetVersionHash: `0x${string}`;
  x402Endpoint: string;
  openApiUrl: string;
  serviceSummary: string;
  mandatoryScenarios: readonly string[];
  /**
   * Scenario IDs the pipeline actually has an executor for. Proposing anything outside this list
   * is harmless but pointless: the deterministic compiler will include it in the plan, but the
   * pipeline's scenario registry has nothing to run it with, so it is silently skipped.
   */
  availableScenarios: readonly string[];
  maximumToolBudgetAtomic: string;
}>;

export interface RiskClassifier {
  classify(input: RiskClassificationInput, signal?: AbortSignal): Promise<RiskClassification>;
}
