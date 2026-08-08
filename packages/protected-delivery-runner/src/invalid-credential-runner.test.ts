import { describe, expect, it } from 'vitest';

import { InvalidCredentialRejectionRunner, type InvalidCredentialScenario } from './invalid-credential-runner.js';
import type { ProtectedDeliveryAttempt, ProtectedDeliveryClient } from './replay-runner.js';

const scenario: InvalidCredentialScenario = {
  scenarioId: 'unpaid-access-denial',
  targetServiceId: 'external-paid-service',
  targetVersionHash: `0x${'11'.repeat(32)}`,
  policyHash: `0x${'22'.repeat(32)}`,
  method: 'GET',
  route: '/v1/protected-report',
};

function fakeClient(attempt: ProtectedDeliveryAttempt, expectedReceipt = ''): ProtectedDeliveryClient {
  return {
    async execute(input) {
      if (input.paymentReceipt !== expectedReceipt)
        throw new Error(`expected receipt ${JSON.stringify(expectedReceipt)}`);
      return attempt;
    },
  };
}

describe('invalid credential rejection runner: no receipt at all (unpaid-access-denial)', () => {
  it('produces PASS when the target correctly rejects a request with no receipt', async () => {
    const client = fakeClient({ statusCode: 402, deliveryConfirmed: false, responseBodyHash: `0x${'aa'.repeat(32)}` });

    await expect(new InvalidCredentialRejectionRunner(client).run(scenario)).resolves.toMatchObject({
      result: 'PASS',
      scenarioId: scenario.scenarioId,
      attempts: [{ phase: 'INITIAL', statusCode: 402, deliveryConfirmed: false }],
    });
  });

  it('produces FAIL when the target delivers content with no receipt at all', async () => {
    const client = fakeClient({ statusCode: 200, deliveryConfirmed: true, responseBodyHash: `0x${'bb'.repeat(32)}` });

    await expect(new InvalidCredentialRejectionRunner(client).run(scenario)).resolves.toMatchObject({
      result: 'FAIL',
      failureCode: 'INVALID_CREDENTIAL_ACCEPTED',
    });
  });

  it('returns INCONCLUSIVE rather than a false PASS on an unexpected status class', async () => {
    const client = fakeClient({ statusCode: 500, deliveryConfirmed: false, responseBodyHash: `0x${'cc'.repeat(32)}` });

    await expect(new InvalidCredentialRejectionRunner(client).run(scenario)).resolves.toMatchObject({
      result: 'INCONCLUSIVE',
      failureCode: 'INVALID_CREDENTIAL_PROBE_INCONCLUSIVE',
    });
  });

  it('returns INCONCLUSIVE when the client itself throws', async () => {
    const client: ProtectedDeliveryClient = {
      async execute() {
        throw new Error('network unreachable');
      },
    };

    await expect(new InvalidCredentialRejectionRunner(client).run(scenario)).resolves.toMatchObject({
      result: 'INCONCLUSIVE',
      failureCode: 'INVALID_CREDENTIAL_PROBE_INCONCLUSIVE',
    });
  });

  it('never carries a real payment proof, since none was made', async () => {
    const client = fakeClient({ statusCode: 402, deliveryConfirmed: false, responseBodyHash: `0x${'aa'.repeat(32)}` });

    const result = await new InvalidCredentialRejectionRunner(client).run(scenario);
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

    await expect(
      new InvalidCredentialRejectionRunner(client).run({
        ...scenario,
        route: 'https://attacker.example/protected',
      }),
    ).rejects.toThrow(/origin-relative/);
    expect(called).toBe(false);
  });
});

describe('invalid credential rejection runner: tampered receipt (tampered-receipt-rejection)', () => {
  const tamperedScenario: InvalidCredentialScenario = {
    ...scenario,
    scenarioId: 'tampered-receipt-rejection',
    presentedReceipt: 'earned-receipt-token-corrupted-xxxx',
  };

  it('presents the tampered receipt, not an empty one', async () => {
    const client = fakeClient(
      { statusCode: 402, deliveryConfirmed: false, responseBodyHash: `0x${'aa'.repeat(32)}` },
      'earned-receipt-token-corrupted-xxxx',
    );
    await expect(new InvalidCredentialRejectionRunner(client).run(tamperedScenario)).resolves.toMatchObject({
      result: 'PASS',
    });
  });

  it('produces FAIL if the target accepts a tampered receipt', async () => {
    const client = fakeClient(
      { statusCode: 200, deliveryConfirmed: true, responseBodyHash: `0x${'bb'.repeat(32)}` },
      'earned-receipt-token-corrupted-xxxx',
    );
    await expect(new InvalidCredentialRejectionRunner(client).run(tamperedScenario)).resolves.toMatchObject({
      result: 'FAIL',
      failureCode: 'INVALID_CREDENTIAL_ACCEPTED',
    });
  });

  it('hashes the presented (tampered) receipt, not an empty string', async () => {
    const client = fakeClient(
      { statusCode: 402, deliveryConfirmed: false, responseBodyHash: `0x${'aa'.repeat(32)}` },
      'earned-receipt-token-corrupted-xxxx',
    );
    const result = await new InvalidCredentialRejectionRunner(client).run(tamperedScenario);
    const emptyReceiptResult = await new InvalidCredentialRejectionRunner(
      fakeClient({ statusCode: 402, deliveryConfirmed: false, responseBodyHash: `0x${'aa'.repeat(32)}` }),
    ).run(scenario);
    expect(result.presentedReceiptHash).not.toBe(emptyReceiptResult.presentedReceiptHash);
  });
});
