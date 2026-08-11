import { randomUUID } from 'node:crypto';

import { ProtectedDeliveryReplayRunner, type ReplayScenario } from '@shipyard402/protected-delivery-runner';
import { createFetchProtectedDeliveryClient } from '@shipyard402/protected-delivery-runner';
import {
  buildExactEvmRequirements,
  eip155Network,
  encodePaymentHeader,
  signExactEvmAuthorization,
  X402_VERSION,
  type ExactEvmPayload,
} from '@shipyard402/x402-payments';
import { afterEach, describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';

import { createDemoTargetApp, PAID_RESOURCE_ROUTE, type DemoTargetMode } from './app.js';
import { SettlementError, type X402Settler } from './settler.js';

const CHAIN_ID = 48816;
const ASSET = '0x1111111111111111111111111111111111111111' as const;
const PAY_TO = '0x2222222222222222222222222222222222222222' as const;
const HASH_32_BYTES = `0x${'11'.repeat(32)}` as const;
const payer = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');

/** Mirrors the EIP-3009 token's on-chain replay guard: one settlement per (from, nonce). */
class FakeSettler implements X402Settler {
  readonly used = new Set<string>();

  async settle(payload: ExactEvmPayload): Promise<Readonly<{ transactionHash: `0x${string}` }>> {
    const key = `${payload.authorization.from}:${payload.authorization.nonce}`.toLowerCase();
    if (this.used.has(key)) throw new SettlementError('ALREADY_SETTLED', 'authorization already used');
    this.used.add(key);
    return { transactionHash: `0x${'ab'.repeat(32)}` };
  }
}

describe('V1 vs V2 demo target under the protected-delivery replay runner', () => {
  let app: ReturnType<typeof createDemoTargetApp> | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('FAILs V1_VULNERABLE: the same signed x402 payment is delivered twice', async () => {
    const evidence = await runReplayScenario('V1_VULNERABLE');
    expect(evidence.result).toBe('FAIL');
    expect(evidence.failureCode).toBe('PAYMENT_PROOF_REPLAY_ACCEPTED');
    expect(evidence.attempts).toHaveLength(2);
    expect(evidence.attempts[1]).toMatchObject({ phase: 'REPLAY', statusCode: 200, deliveryConfirmed: true });
  });

  it('PASSes V2_PROTECTED: the replayed payment reverts at settlement and is rejected', async () => {
    const evidence = await runReplayScenario('V2_PROTECTED');
    expect(evidence.result).toBe('PASS');
    expect(evidence.failureCode).toBeUndefined();
    expect(evidence.attempts).toHaveLength(2);
    expect(evidence.attempts[1]).toMatchObject({ phase: 'REPLAY', statusCode: 409, deliveryConfirmed: false });
  });

  async function runReplayScenario(mode: DemoTargetMode) {
    app = createDemoTargetApp({
      mode,
      payment: {
        chainId: CHAIN_ID,
        asset: ASSET,
        payTo: PAY_TO,
        amountAtomic: '1000',
        tokenName: 'Shipyard Testnet Token',
        tokenVersion: '1',
        settler: new FakeSettler(),
      },
    });
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });

    // A single real signed x402 payment; the replay attack presents this exact header twice.
    const requirements = buildExactEvmRequirements({
      chainId: CHAIN_ID,
      amountAtomic: '1000',
      resource: `${baseUrl}${PAID_RESOURCE_ROUTE}`,
      payTo: PAY_TO,
      asset: ASSET,
      tokenName: 'Shipyard Testnet Token',
      tokenVersion: '1',
    });
    const nowSec = Math.floor(Date.now() / 1000);
    const payload = await signExactEvmAuthorization({
      requirements,
      from: payer.address,
      nonce: `0x${'42'.repeat(32)}`,
      validAfterSec: nowSec - 60,
      validBeforeSec: nowSec + 600,
      signTypedData: (args) => payer.signTypedData(args),
    });
    const paymentHeader = encodePaymentHeader({
      x402Version: X402_VERSION,
      scheme: 'exact',
      network: eip155Network(CHAIN_ID),
      payload,
    });

    const scenario: ReplayScenario = {
      scenarioId: `replay-demo-${mode}-${randomUUID()}`,
      targetServiceId: 'x402-demo-target',
      targetVersionHash: HASH_32_BYTES,
      policyHash: HASH_32_BYTES,
      method: 'GET',
      route: PAID_RESOURCE_ROUTE,
      paymentReceipt: paymentHeader,
      paymentProofHash: HASH_32_BYTES,
    };

    const runner = new ProtectedDeliveryReplayRunner(createFetchProtectedDeliveryClient(baseUrl));
    return runner.run(scenario);
  }
});
