import type OpenAI from 'openai';
import { describe, expect, it } from 'vitest';

import { OpenAiRiskClassifier, RiskClassificationUnavailableError } from './openai-risk-classifier.js';
import type { RiskClassificationInput } from './ports.js';

const input: RiskClassificationInput = {
  targetServiceId: 'service:demo',
  targetVersionHash: `0x${'11'.repeat(32)}`,
  x402Endpoint: 'https://target.example/paid',
  openApiUrl: 'https://target.example/openapi.json',
  serviceSummary: 'A small paid resource used for testnet demonstration.',
  mandatoryScenarios: ['payment-proof-replay'],
  maximumToolBudgetAtomic: '1000000',
};

function fakeClient(outputText: string): OpenAI {
  return {
    responses: {
      create: async () => ({ output_text: outputText }),
    },
  } as unknown as OpenAI;
}

describe('OpenAiRiskClassifier', () => {
  it('requires an API key', () => {
    expect(() => new OpenAiRiskClassifier({ apiKey: '', model: 'gpt-5.1' }))
      .toThrowError(RiskClassificationUnavailableError);
  });

  it('requires a model', () => {
    expect(() => new OpenAiRiskClassifier({ apiKey: 'sk-test', model: '' }))
      .toThrowError(RiskClassificationUnavailableError);
  });

  it('returns a validated classification on a well-formed response', async () => {
    const classifier = new OpenAiRiskClassifier({
      apiKey: 'sk-test',
      model: 'gpt-5.1',
      client: fakeClient(JSON.stringify({
        riskLevel: 'MEDIUM',
        proposedScenarios: ['payment-proof-replay', 'schema-drift'],
        proposedToolBudgetAtomic: '500000',
        rationale: 'Payment-gated resource with replay-sensitive delivery semantics.',
      })),
    });

    await expect(classifier.classify(input)).resolves.toMatchObject({
      riskLevel: 'MEDIUM',
      proposedScenarios: ['payment-proof-replay', 'schema-drift'],
    });
  });

  it('fails closed when the response is not valid JSON', async () => {
    const classifier = new OpenAiRiskClassifier({
      apiKey: 'sk-test',
      model: 'gpt-5.1',
      client: fakeClient('not json'),
    });
    await expect(classifier.classify(input)).rejects.toThrowError(RiskClassificationUnavailableError);
  });

  it('fails closed when the response violates the schema', async () => {
    const classifier = new OpenAiRiskClassifier({
      apiKey: 'sk-test',
      model: 'gpt-5.1',
      client: fakeClient(JSON.stringify({ riskLevel: 'EXTREME', proposedScenarios: [], proposedToolBudgetAtomic: '-5', rationale: '' })),
    });
    await expect(classifier.classify(input)).rejects.toThrowError(RiskClassificationUnavailableError);
  });

  it('fails closed when the underlying request throws', async () => {
    const throwingClient = {
      responses: {
        create: async () => {
          throw new Error('network unreachable');
        },
      },
    } as unknown as OpenAI;
    const classifier = new OpenAiRiskClassifier({ apiKey: 'sk-test', model: 'gpt-5.1', client: throwingClient });
    await expect(classifier.classify(input)).rejects.toThrowError(RiskClassificationUnavailableError);
  });
});
