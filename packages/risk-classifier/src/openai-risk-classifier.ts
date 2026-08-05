import OpenAI from 'openai';

import { riskClassificationSchema, type RiskClassification, type RiskClassificationInput, type RiskClassifier } from './ports.js';

export class RiskClassificationUnavailableError extends Error {
  constructor(reason: string, options?: { cause?: unknown }) {
    super(`Risk classification unavailable: ${reason}`, options);
    this.name = 'RiskClassificationUnavailableError';
  }
}

const RISK_CLASSIFICATION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    riskLevel: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
    proposedScenarios: {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      items: { type: 'string', pattern: '^[a-z0-9][a-z0-9_.-]{1,127}$' },
    },
    proposedToolBudgetAtomic: { type: 'string', pattern: '^(0|[1-9]\\d*)$' },
    rationale: { type: 'string', minLength: 1, maxLength: 2000 },
  },
  required: ['riskLevel', 'proposedScenarios', 'proposedToolBudgetAtomic', 'rationale'],
  additionalProperties: false,
} as const;

export type OpenAiRiskClassifierOptions = Readonly<{
  apiKey: string;
  model: string;
  client?: OpenAI;
}>;

export class OpenAiRiskClassifier implements RiskClassifier {
  readonly #client: OpenAI;
  readonly #model: string;

  constructor(options: OpenAiRiskClassifierOptions) {
    if (!options.apiKey) throw new RiskClassificationUnavailableError('OPENAI_API_KEY is required');
    if (!options.model) throw new RiskClassificationUnavailableError('OPENAI_MODEL is required');
    this.#client = options.client ?? new OpenAI({ apiKey: options.apiKey });
    this.#model = options.model;
  }

  async classify(input: RiskClassificationInput, signal?: AbortSignal): Promise<RiskClassification> {
    let outputText: string;
    try {
      const response = await this.#client.responses.create(
        {
          model: this.#model,
          input: buildPrompt(input),
          text: {
            format: {
              type: 'json_schema',
              name: 'shipyard_risk_classification',
              strict: true,
              schema: RISK_CLASSIFICATION_JSON_SCHEMA,
            },
          },
        },
        signal === undefined ? undefined : { signal },
      );
      outputText = response.output_text;
    } catch (error) {
      throw new RiskClassificationUnavailableError('OpenAI request failed', { cause: error });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(outputText);
    } catch (error) {
      throw new RiskClassificationUnavailableError('OpenAI response was not valid JSON', { cause: error });
    }

    const validated = riskClassificationSchema.safeParse(parsed);
    if (!validated.success) {
      throw new RiskClassificationUnavailableError('OpenAI response failed schema validation', { cause: validated.error });
    }
    return validated.data;
  }
}

function buildPrompt(input: RiskClassificationInput): string {
  return [
    'You are a release-risk classifier for an x402-paid API. You propose; you never decide.',
    'Deterministic code will clamp your proposed budget and always run mandatory scenarios regardless of what you propose.',
    `Target service ID: ${input.targetServiceId}`,
    `Target version hash: ${input.targetVersionHash}`,
    `Paid x402 endpoint: ${input.x402Endpoint}`,
    `OpenAPI document: ${input.openApiUrl}`,
    `Service summary: ${input.serviceSummary}`,
    `Mandatory scenarios that will always run regardless of your answer: ${input.mandatoryScenarios.join(', ')}`,
    `Scenario IDs the pipeline can actually execute: ${input.availableScenarios.join(', ')}. Proposing an ID outside this list changes nothing -- it will not run.`,
    `Maximum tool budget (atomic units, do not exceed): ${input.maximumToolBudgetAtomic}`,
    'Propose a risk level, any additional scenario IDs beyond the mandatory ones (only from the executable list above), a tool budget within the ceiling, and a short rationale.',
  ].join('\n');
}
