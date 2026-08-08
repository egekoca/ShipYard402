import { randomUUID } from 'node:crypto';

import { ProtectedDeliveryReplayRunner, type ReplayScenario } from '@shipyard402/protected-delivery-runner';
import { afterEach, describe, expect, it } from 'vitest';

import { createDemoTargetApp, PAID_RESOURCE_ROUTE, type DemoTargetMode } from './app.js';
import { createFetchProtectedDeliveryClient } from '@shipyard402/protected-delivery-runner';
import { issueDemoReceipt } from './receipt.js';

const SECRET = 'a'.repeat(32);
const HASH_32_BYTES = `0x${'11'.repeat(32)}` as const;

describe('V1 vs V2 demo target under the protected-delivery replay runner', () => {
  let app: ReturnType<typeof createDemoTargetApp> | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('FAILs V1_VULNERABLE: the same payment receipt is accepted twice', async () => {
    const evidence = await runReplayScenario('V1_VULNERABLE');
    expect(evidence.result).toBe('FAIL');
    expect(evidence.failureCode).toBe('PAYMENT_PROOF_REPLAY_ACCEPTED');
    expect(evidence.attempts).toHaveLength(2);
    expect(evidence.attempts[1]).toMatchObject({ phase: 'REPLAY', statusCode: 200, deliveryConfirmed: true });
  });

  it('PASSes V2_PROTECTED: the replayed receipt is rejected as already redeemed', async () => {
    const evidence = await runReplayScenario('V2_PROTECTED');
    expect(evidence.result).toBe('PASS');
    expect(evidence.failureCode).toBeUndefined();
    expect(evidence.attempts).toHaveLength(2);
    expect(evidence.attempts[1]).toMatchObject({ phase: 'REPLAY', statusCode: 409, deliveryConfirmed: false });
  });

  async function runReplayScenario(mode: DemoTargetMode) {
    app = createDemoTargetApp({ mode, receiptSecret: SECRET });
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });

    const receipt = issueDemoReceipt(
      { orderId: `order-${randomUUID()}`, atomicAmount: '1000', resource: PAID_RESOURCE_ROUTE, validForSeconds: 60 },
      SECRET,
    );
    const scenario: ReplayScenario = {
      scenarioId: `replay-demo-${mode}-${randomUUID()}`,
      targetServiceId: 'x402-demo-target',
      targetVersionHash: HASH_32_BYTES,
      policyHash: HASH_32_BYTES,
      method: 'GET',
      route: PAID_RESOURCE_ROUTE,
      paymentReceipt: receipt,
      paymentProofHash: HASH_32_BYTES,
    };

    const runner = new ProtectedDeliveryReplayRunner(createFetchProtectedDeliveryClient(baseUrl));
    return runner.run(scenario);
  }
});
