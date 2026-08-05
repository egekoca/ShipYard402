import { describe, expect, it } from 'vitest';

import type { ProtectedDeliveryAttempt, ProtectedDeliveryClient } from './replay-runner.js';
import { UnpaidAccessDenialRunner, type UnpaidAccessScenario } from './unpaid-access-runner.js';

const scenario: UnpaidAccessScenario = {
  scenarioId: 'unpaid-access-denial',
  targetServiceId: 'external-paid-service',
  targetVersionHash: `0x${'11'.repeat(32)}`,
  policyHash: `0x${'22'.repeat(32)}`,
  method: 'GET',
  route: '/v1/protected-report',
};

function fakeClient(attempt: ProtectedDeliveryAttempt): ProtectedDeliveryClient {
  return {
    async execute(input) {
      if (input.paymentReceipt !== '') throw new Error('expected an empty payment receipt for this scenario');
      return attempt;
    },
  };
}

describe('unpaid access denial runner', () => {
  it('produces PASS when the target correctly rejects a request with no receipt', async () => {
    const client = fakeClient({ statusCode: 402, deliveryConfirmed: false, responseBodyHash: `0x${'aa'.repeat(32)}` });

    await expect(new UnpaidAccessDenialRunner(client).run(scenario)).resolves.toMatchObject({
      result: 'PASS',
      scenarioId: scenario.scenarioId,
      attempts: [{ phase: 'INITIAL', statusCode: 402, deliveryConfirmed: false }],
    });
  });

  it('produces FAIL when the target delivers content with no receipt at all', async () => {
    const client = fakeClient({ statusCode: 200, deliveryConfirmed: true, responseBodyHash: `0x${'bb'.repeat(32)}` });

    await expect(new UnpaidAccessDenialRunner(client).run(scenario)).resolves.toMatchObject({
      result: 'FAIL',
      failureCode: 'UNPAID_ACCESS_ACCEPTED',
    });
  });

  it('returns INCONCLUSIVE rather than a false PASS on an unexpected status class', async () => {
    const client = fakeClient({ statusCode: 500, deliveryConfirmed: false, responseBodyHash: `0x${'cc'.repeat(32)}` });

    await expect(new UnpaidAccessDenialRunner(client).run(scenario)).resolves.toMatchObject({
      result: 'INCONCLUSIVE',
      failureCode: 'UNPAID_ACCESS_PROBE_INCONCLUSIVE',
    });
  });

  it('returns INCONCLUSIVE when the client itself throws', async () => {
    const client: ProtectedDeliveryClient = {
      async execute() {
        throw new Error('network unreachable');
      },
    };

    await expect(new UnpaidAccessDenialRunner(client).run(scenario)).resolves.toMatchObject({
      result: 'INCONCLUSIVE',
      failureCode: 'UNPAID_ACCESS_PROBE_INCONCLUSIVE',
    });
  });

  it('never carries a real payment proof, since none was made', async () => {
    const client = fakeClient({ statusCode: 402, deliveryConfirmed: false, responseBodyHash: `0x${'aa'.repeat(32)}` });

    const result = await new UnpaidAccessDenialRunner(client).run(scenario);
    expect(result.paymentProofHash).toBe(`0x${'0'.repeat(64)}`);
  });

  it('rejects absolute routes before giving the client any access', async () => {
    let called = false;
    const client: ProtectedDeliveryClient = {
      async execute() {
        called = true;
        throw new Error('must not execute');
      },
    };

    await expect(new UnpaidAccessDenialRunner(client).run({
      ...scenario,
      route: 'https://attacker.example/protected',
    })).rejects.toThrow(/origin-relative/);
    expect(called).toBe(false);
  });
});
