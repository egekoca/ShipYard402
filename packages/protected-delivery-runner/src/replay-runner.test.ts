import { describe, expect, it } from 'vitest';

import {
  ProtectedDeliveryReplayRunner,
  type ProtectedDeliveryAttempt,
  type ProtectedDeliveryClient,
  type ReplayScenario,
} from './replay-runner.js';

const responseHash = `0x${'aa'.repeat(32)}` as const;
const scenario: ReplayScenario = {
  scenarioId: 'replay-proof-1',
  targetServiceId: 'external-paid-service',
  targetVersionHash: `0x${'11'.repeat(32)}`,
  policyHash: `0x${'22'.repeat(32)}`,
  method: 'POST',
  route: '/v1/protected-report',
  requestBody: { query: 'release-risk' },
  paymentReceipt: 'sensitive-signed-receipt',
  paymentProofHash: `0x${'33'.repeat(32)}`,
};

describe('protected delivery replay runner', () => {
  it('produces deterministic FAIL evidence when V1 accepts one proof twice', async () => {
    const client = sequence([
      { statusCode: 200, deliveryConfirmed: true, responseBodyHash: responseHash },
      { statusCode: 200, deliveryConfirmed: true, responseBodyHash: responseHash },
    ]);

    const result = await new ProtectedDeliveryReplayRunner(client).run(scenario);

    expect(result).toMatchObject({
      result: 'FAIL',
      failureCode: 'PAYMENT_PROOF_REPLAY_ACCEPTED',
      paymentProofHash: scenario.paymentProofHash,
      presentedReceiptHash: expect.stringMatching(/^0x[a-f0-9]{64}$/),
      attempts: [
        { phase: 'INITIAL', statusCode: 200, deliveryConfirmed: true },
        { phase: 'REPLAY', statusCode: 200, deliveryConfirmed: true },
      ],
    });
    expect(result.attempts[0]?.requestHash).not.toBe(result.attempts[1]?.requestHash);
    expect(JSON.stringify(result)).not.toContain(scenario.paymentReceipt);
  });

  it('produces PASS evidence when V2 atomically rejects the replay', async () => {
    const client = sequence([
      { statusCode: 200, deliveryConfirmed: true, responseBodyHash: responseHash },
      { statusCode: 409, deliveryConfirmed: false, responseBodyHash: `0x${'bb'.repeat(32)}` },
    ]);

    await expect(
      new ProtectedDeliveryReplayRunner(client).run({
        ...scenario,
        targetVersionHash: `0x${'44'.repeat(32)}`,
        route: '/v2/protected-report',
      }),
    ).resolves.toMatchObject({ result: 'PASS', attempts: [{ statusCode: 200 }, { statusCode: 409 }] });
  });

  it('returns INCONCLUSIVE rather than a false PASS when the replay probe times out', async () => {
    let calls = 0;
    const client: ProtectedDeliveryClient = {
      async execute() {
        calls += 1;
        if (calls === 2) throw new Error('provider timeout');
        return { statusCode: 200, deliveryConfirmed: true, responseBodyHash: responseHash };
      },
    };

    await expect(new ProtectedDeliveryReplayRunner(client).run(scenario)).resolves.toMatchObject({
      result: 'INCONCLUSIVE',
      failureCode: 'REPLAY_PROBE_INCONCLUSIVE',
      attempts: [{ statusCode: 200 }, { phase: 'REPLAY' }],
    });
  });

  it('rejects absolute routes before giving the client receipt access', async () => {
    let called = false;
    const client: ProtectedDeliveryClient = {
      async execute() {
        called = true;
        throw new Error('must not execute');
      },
    };

    await expect(
      new ProtectedDeliveryReplayRunner(client).run({
        ...scenario,
        route: 'https://attacker.example/protected',
      }),
    ).rejects.toThrow(/origin-relative/);
    expect(called).toBe(false);
  });

  it.each(['/\\\\attacker.example/protected', '/%5c%5cattacker.example/protected', '/protected#ignored-fragment'])(
    'rejects ambiguous origin-relative route %s',
    async (route) => {
      const client: ProtectedDeliveryClient = {
        async execute() {
          throw new Error('must not execute');
        },
      };

      await expect(new ProtectedDeliveryReplayRunner(client).run({ ...scenario, route })).rejects.toThrow(
        /origin-relative/,
      );
    },
  );
});

function sequence(attempts: readonly ProtectedDeliveryAttempt[]): ProtectedDeliveryClient {
  let index = 0;
  return {
    async execute() {
      const attempt = attempts[index];
      index += 1;
      if (!attempt) throw new Error('unexpected request');
      return attempt;
    },
  };
}
