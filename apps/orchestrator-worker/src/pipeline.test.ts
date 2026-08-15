import type { AttestationRecord, EvidencePack, OrchestratorRunCheckpoint } from '@shipyard402/persistence-postgres';
import type { RunAggregate, RunStatus, RunTransitionedEvent } from '@shipyard402/run-domain';
import { createDraftRun, transitionRun } from '@shipyard402/run-domain';
import { buildExactEvmRequirements, encodePaymentHeader } from '@shipyard402/x402-payments';
import { getBytes, Wallet } from 'ethers';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  finalizeRunAsInconclusive,
  OrchestratorPipelineError,
  RunNotReadyForOrchestrationError,
  runOrchestratorPipeline,
  type AttestationStorePort,
  type CheckpointStorePort,
  type EvidencePackStorePort,
  type OrchestratorPipelineDependencies,
} from './pipeline.js';
import type { QuoteRepositoryPort, RunRecord, RunRepositoryPort } from './ports.js';

const RUN_ID = 'run_test_1';
const NOW = new Date('2026-08-05T00:00:00.000Z');
const PAYMENT_NONCE = `0x${'55'.repeat(32)}` as const;

function paymentReceipt(amountAtomic = '100', nonce: `0x${string}` = PAYMENT_NONCE): string {
  return encodePaymentHeader({
    x402Version: 1,
    scheme: 'exact',
    network: 'eip155:48816',
    payload: {
      signature: `0x${'12'.repeat(65)}`,
      authorization: {
        from: '0x5000000000000000000000000000000000000005',
        to: '0x4000000000000000000000000000000000000004',
        value: amountAtomic,
        validAfter: '0',
        validBefore: '9999999999',
        nonce,
      },
    },
  });
}

function fundedRun(): RunAggregate {
  let run = createDraftRun(RUN_ID, NOW.toISOString());
  for (const to of ['QUOTED', 'PAYMENT_REQUIRED', 'FUNDED'] as const) {
    const result = transitionRun(run, {
      actor: to === 'QUOTED' ? 'QUOTE_ENGINE' : to === 'PAYMENT_REQUIRED' ? 'MERCHANT_GATEWAY' : 'PAYMENT_RECONCILER',
      expectedRevision: run.revision,
      idempotencyKey: `setup:${to}`,
      occurredAt: NOW.toISOString(),
      to,
    });
    run = result.run;
  }
  return run;
}

function fakeRunRepository(initial: RunAggregate): RunRepositoryPort & { saved: RunTransitionedEvent[] } {
  let current: RunRecord = {
    aggregate: initial,
    quoteId: 'quote_1',
    requestIdempotencyKey: 'request_1',
    customerPaymentProofHash: `0x${'ab'.repeat(32)}`,
    customerPaymentAtomic: '1000000',
  };
  const saved: RunTransitionedEvent[] = [];
  return {
    saved,
    async findById(id) {
      return id === current.aggregate.id ? current : null;
    },
    async save(record, expectedPersistedRevision) {
      if (current.aggregate.revision !== expectedPersistedRevision) throw new Error('revision conflict');
      current = { ...current, aggregate: record.aggregate };
      saved.push(record.uncommittedEvent);
    },
  };
}

const ORCHESTRATOR_STEP_ACTORS = {
  ANALYZING: 'ORCHESTRATOR',
  PLAN_COMPILED: 'POLICY_ENGINE',
  PROCURING: 'PROCUREMENT_WORKER',
  EXECUTING: 'PROCUREMENT_WORKER',
  EVIDENCE_BUILDING: 'EXECUTION_WORKER',
  ATTESTING: 'EVIDENCE_WORKER',
} as const;

function runAtStatus(status: RunStatus): RunAggregate {
  let run = fundedRun();
  if (status === 'FUNDED') return run;
  for (const to of Object.keys(ORCHESTRATOR_STEP_ACTORS) as (keyof typeof ORCHESTRATOR_STEP_ACTORS)[]) {
    const result = transitionRun(run, {
      actor: ORCHESTRATOR_STEP_ACTORS[to],
      expectedRevision: run.revision,
      idempotencyKey: `setup:${to}`,
      occurredAt: NOW.toISOString(),
      to,
    });
    run = result.run;
    if (to === status) break;
  }
  return run;
}

function fakeCheckpointStore(
  initial: OrchestratorRunCheckpoint = {},
): CheckpointStorePort & { state: OrchestratorRunCheckpoint } {
  const store = {
    state: initial,
    async load(_runId: string) {
      return store.state;
    },
    async merge(_runId: string, patch: OrchestratorRunCheckpoint) {
      // Matches the real store's COALESCE semantics: an already-persisted field wins over a
      // new writer's value, and the caller gets back the authoritative merged row.
      const merged: Record<string, unknown> = { ...store.state };
      for (const [key, value] of Object.entries(patch)) {
        if (merged[key] === undefined) merged[key] = value;
      }
      store.state = merged as OrchestratorRunCheckpoint;
      return store.state;
    },
  };
  return store;
}

function fakeEvidencePackStore(existing: EvidencePack | null = null): EvidencePackStorePort & { puts: EvidencePack[] } {
  const store = {
    puts: [] as EvidencePack[],
    stored: existing,
    async put(pack: EvidencePack) {
      store.stored = pack;
      store.puts.push(pack);
    },
    async getByRunId() {
      return store.stored;
    },
  };
  return store;
}

function fakeAttestationStore(
  existing: AttestationRecord | null = null,
): AttestationStorePort & { puts: AttestationRecord[] } {
  const store = {
    puts: [] as AttestationRecord[],
    stored: existing,
    async put(record: AttestationRecord) {
      store.stored = record;
      store.puts.push(record);
    },
    async getByRunId() {
      return store.stored;
    },
  };
  return store;
}

function fakeQuoteRepository(): QuoteRepositoryPort {
  return {
    async findById() {
      return {
        id: 'quote_1',
        request: {
          organizationId: '11111111-1111-1111-1111-111111111111',
          requesterAddress: '0x2000000000000000000000000000000000000002',
          targetAgentId: 'agent:demo',
          targetServiceId: 'service:demo',
          targetVersionHash: `0x${'11'.repeat(32)}`,
          policyHash: `0x${'22'.repeat(32)}`,
          x402Endpoint: 'https://target.example/paid',
          openApiUrl: 'https://target.example/openapi.json',
          maximumCustomerBudgetAtomic: '1000000',
        },
        capabilitySnapshot: {
          environment: 'testnet3',
          merchantId: 'merchant-1',
          mode: 'ERC20_DIRECT',
          chainId: 48816,
          tokenAddress: '0x1000000000000000000000000000000000000001',
          tokenSymbol: 'TEST',
          tokenDecimals: 6,
          receivingAddress: '0x3000000000000000000000000000000000000003',
          minimumAtomicAmount: '1',
          maximumAtomicAmount: '100000000',
          discoveredAt: NOW.toISOString(),
          source: 'PORTAL_REVIEW',
        },
        pricingStatus: 'HYPOTHESIS',
        lineItems: {
          baseOrchestrationFeeAtomic: '100',
          mandatoryToolBudgetAtomic: '100',
          dynamicToolBudgetAtomic: '100',
          modelInfrastructureReserveAtomic: '100',
          chainStorageReserveAtomic: '100',
          riskSupportReserveAtomic: '100',
        },
        totalAtomicAmount: '600',
        refundableToolBudgetAtomic: '200',
        createdAt: NOW.toISOString(),
        expiresAt: new Date(NOW.getTime() + 900_000).toISOString(),
        quoteCommitment: `0x${'33'.repeat(32)}`,
      };
    },
  };
}

function baseDeps(
  overrides: Partial<OrchestratorPipelineDependencies> = {},
  /** What the fake target charges; the worker discovers the real price from the 402 it is served. */
  configuredAmount = '100',
): OrchestratorPipelineDependencies {
  const defaultDeliveryClient = {
    async execute(input: { idempotencyKey: string }) {
      return {
        statusCode: input.idempotencyKey.endsWith(':replay') ? 409 : 200,
        deliveryConfirmed: !input.idempotencyKey.endsWith(':replay'),
        responseBodyHash: `0x${'44'.repeat(32)}` as const,
      };
    },
  };
  return {
    runRepository: fakeRunRepository(fundedRun()),
    quoteRepository: fakeQuoteRepository(),
    riskClassifier: {
      async classify() {
        return {
          riskLevel: 'MEDIUM',
          proposedScenarios: ['payment-proof-replay'],
          proposedToolBudgetAtomic: '150',
          rationale: 'test',
        };
      },
    },
    mandatoryScenarios: ['payment-proof-replay'],
    shipyardAgentId: 'shipyard:orchestrator',
    homeChainId: 48816,
    demoTarget: {
      toolAgentId: 'agent:demo-target',
      toolVersion: 'x402-demo-target@0.1.0',
      chainId: 48816,
    },
    procurementAllowedAssets: ['0x1000000000000000000000000000000000000001'],
    deliveryClientFor: () => defaultDeliveryClient,
    x402Payer: {
      payerAddress: '0x5000000000000000000000000000000000000005',
      async acquire(input) {
        const requirements = buildExactEvmRequirements({
          chainId: input.expectedChainId,
          amountAtomic: configuredAmount,
          resource: input.endpoint,
          payTo: '0x4000000000000000000000000000000000000004',
          asset: '0x1000000000000000000000000000000000000001',
          tokenName: 'TEST',
          tokenVersion: '1',
        });
        return {
          requirements,
          paymentHeader: paymentReceipt(configuredAmount),
          authorization: {
            from: '0x5000000000000000000000000000000000000005',
            to: requirements.payTo,
            value: configuredAmount,
            validAfter: String(input.validAfterSec),
            validBefore: String(input.validBeforeSec),
            nonce: PAYMENT_NONCE,
          },
        };
      },
    },
    toolReceiptSigner: {
      address: '0x6000000000000000000000000000000000000006',
      async sign() {
        return `0x${'66'.repeat(65)}`;
      },
    },
    evidencePackStore: fakeEvidencePackStore(),
    evidencePublisher: {
      async publish(content) {
        return `ipfs://bafkfake${createHash('sha256').update(content).digest('hex').slice(0, 40)}`;
      },
    },
    attestor: {
      address: '0x7000000000000000000000000000000000000007',
      registryAddress: '0x07f6a55Fb88DD29e9A10802ce8d706dA26db8ddd',
      chainId: 48816,
      async submit() {
        return `0x${'77'.repeat(32)}`;
      },
    },
    attestationStore: fakeAttestationStore(),
    checkpointStore: fakeCheckpointStore(),
    now: () => NOW,
    ...overrides,
  };
}

describe('runOrchestratorPipeline', () => {
  it('walks a FUNDED run all the way to DELIVERED_PASS when the replay check passes', async () => {
    const deps = baseDeps();
    const result = await runOrchestratorPipeline(RUN_ID, deps);
    expect(result).toMatchObject({ runId: RUN_ID, finalStatus: 'DELIVERED_PASS' });
    expect((deps.runRepository as ReturnType<typeof fakeRunRepository>).saved.map((event) => event.to)).toEqual([
      'ANALYZING',
      'PLAN_COMPILED',
      'PROCURING',
      'EXECUTING',
      'EVIDENCE_BUILDING',
      'ATTESTING',
      'DELIVERED_PASS',
    ]);
  });

  it('delivers DELIVERED_FAIL when the target accepts a replayed payment receipt', async () => {
    const deps = baseDeps({
      deliveryClientFor: () => ({
        async execute() {
          return { statusCode: 200, deliveryConfirmed: true, responseBodyHash: `0x${'44'.repeat(32)}` };
        },
      }),
    });
    const result = await runOrchestratorPipeline(RUN_ID, deps);
    expect(result.finalStatus).toBe('DELIVERED_FAIL');
  });

  it('executes every AI-proposed scenario that has a registered executor, and silently skips ones that do not', async () => {
    const evidencePackStore = fakeEvidencePackStore();
    const deps = baseDeps({
      riskClassifier: {
        async classify() {
          return {
            riskLevel: 'MEDIUM',
            proposedScenarios: ['unpaid-access-denial', 'schema-drift-nobody-implements'],
            proposedToolBudgetAtomic: '150',
            rationale: 'test',
          };
        },
      },
      deliveryClientFor: () => ({
        async execute(input) {
          // unpaid-access-denial presents no receipt at all; payment-proof-replay presents one.
          if (input.paymentReceipt === '') {
            return { statusCode: 402, deliveryConfirmed: false, responseBodyHash: `0x${'ee'.repeat(32)}` };
          }
          return {
            statusCode: input.idempotencyKey.endsWith(':replay') ? 409 : 200,
            deliveryConfirmed: !input.idempotencyKey.endsWith(':replay'),
            responseBodyHash: `0x${'44'.repeat(32)}`,
          };
        },
      }),
      evidencePackStore,
    });

    const result = await runOrchestratorPipeline(RUN_ID, deps);
    expect(result.finalStatus).toBe('DELIVERED_PASS');
    const stored = evidencePackStore.puts[0];
    if (!stored) throw new Error('expected an evidence pack to have been stored');
    expect(stored.publicManifest).toMatchObject({
      scenarios: expect.arrayContaining(['payment-proof-replay', 'unpaid-access-denial']),
    });
    expect((stored.publicManifest as { toolReceipts: readonly unknown[] }).toolReceipts).toHaveLength(2);
  });

  it('presents a deliberately corrupted receipt for tampered-receipt-rejection, not the real one', async () => {
    let sawTamperedReceipt = false;
    let sawRealReceiptOutsideItsOwnScenario = false;
    const deps = baseDeps({
      riskClassifier: {
        async classify() {
          return {
            riskLevel: 'MEDIUM',
            proposedScenarios: ['tampered-receipt-rejection'],
            proposedToolBudgetAtomic: '150',
            rationale: 'test',
          };
        },
      },
      deliveryClientFor: () => ({
        async execute(input) {
          if (input.paymentReceipt === `${paymentReceipt()}-tampered`) {
            sawTamperedReceipt = true;
            return { statusCode: 402, deliveryConfirmed: false, responseBodyHash: `0x${'ee'.repeat(32)}` };
          }
          if (input.paymentReceipt === paymentReceipt() && !input.idempotencyKey.startsWith('payment-proof-replay:')) {
            sawRealReceiptOutsideItsOwnScenario = true;
          }
          return {
            statusCode: input.idempotencyKey.endsWith(':replay') ? 409 : 200,
            deliveryConfirmed: !input.idempotencyKey.endsWith(':replay'),
            responseBodyHash: `0x${'44'.repeat(32)}`,
          };
        },
      }),
    });

    const result = await runOrchestratorPipeline(RUN_ID, deps);
    expect(result.finalStatus).toBe('DELIVERED_PASS');
    expect(sawTamperedReceipt).toBe(true);
    expect(sawRealReceiptOutsideItsOwnScenario).toBe(false);
  });

  it('aggregates to DELIVERED_FAIL if any executed scenario fails, even when others pass', async () => {
    const deps = baseDeps({
      riskClassifier: {
        async classify() {
          return {
            riskLevel: 'MEDIUM',
            proposedScenarios: ['unpaid-access-denial'],
            proposedToolBudgetAtomic: '150',
            rationale: 'test',
          };
        },
      },
      deliveryClientFor: () => ({
        async execute(input) {
          // unpaid-access-denial: target wrongly serves content with no receipt -> FAIL.
          if (input.paymentReceipt === '') {
            return { statusCode: 200, deliveryConfirmed: true, responseBodyHash: `0x${'ee'.repeat(32)}` };
          }
          // payment-proof-replay still passes on its own.
          return {
            statusCode: input.idempotencyKey.endsWith(':replay') ? 409 : 200,
            deliveryConfirmed: !input.idempotencyKey.endsWith(':replay'),
            responseBodyHash: `0x${'44'.repeat(32)}`,
          };
        },
      }),
    });

    const result = await runOrchestratorPipeline(RUN_ID, deps);
    expect(result.finalStatus).toBe('DELIVERED_FAIL');
  });

  describe('provider signature verification (opt-in via demoTarget.providerSignerAddress)', () => {
    const providerWallet = new Wallet(`0x${'55'.repeat(32)}`);
    const providerAddress = providerWallet.address as `0x${string}`;
    const responseHash = `0x${'44'.repeat(32)}` as const;

    async function signedDeliveryClient(hash: `0x${string}`, signer: Wallet | null) {
      const signature = signer ? ((await signer.signMessage(getBytes(hash))) as `0x${string}`) : undefined;
      return {
        async execute(input: { idempotencyKey: string }) {
          return {
            statusCode: input.idempotencyKey.endsWith(':replay') ? 409 : 200,
            deliveryConfirmed: !input.idempotencyKey.endsWith(':replay'),
            responseBodyHash: hash,
            ...(signature ? { providerSignature: signature } : {}),
          };
        },
      };
    }

    it('keeps PASS when every response is validly signed by the registered provider', async () => {
      const deliveryClient = await signedDeliveryClient(responseHash, providerWallet);
      const deps = baseDeps({
        demoTarget: { ...baseDeps().demoTarget, providerSignerAddress: providerAddress },
        deliveryClientFor: () => deliveryClient,
      });
      await expect(runOrchestratorPipeline(RUN_ID, deps)).resolves.toMatchObject({ finalStatus: 'DELIVERED_PASS' });
    });

    it('downgrades PASS to INCONCLUSIVE when a registered signer is expected but no signature is present', async () => {
      const deliveryClient = await signedDeliveryClient(responseHash, null);
      const deps = baseDeps({
        demoTarget: { ...baseDeps().demoTarget, providerSignerAddress: providerAddress },
        deliveryClientFor: () => deliveryClient,
      });
      await expect(runOrchestratorPipeline(RUN_ID, deps)).resolves.toMatchObject({
        finalStatus: 'DELIVERED_INCONCLUSIVE',
      });
    });

    it('downgrades PASS to INCONCLUSIVE when the signature is real but from the wrong signer', async () => {
      const impostorWallet = new Wallet(`0x${'66'.repeat(32)}`);
      const deliveryClient = await signedDeliveryClient(responseHash, impostorWallet);
      const deps = baseDeps({
        demoTarget: { ...baseDeps().demoTarget, providerSignerAddress: providerAddress },
        deliveryClientFor: () => deliveryClient,
      });
      await expect(runOrchestratorPipeline(RUN_ID, deps)).resolves.toMatchObject({
        finalStatus: 'DELIVERED_INCONCLUSIVE',
      });
    });

    it('does not check signatures at all when no provider signer is registered (default)', async () => {
      const deliveryClient = await signedDeliveryClient(responseHash, null);
      const deps = baseDeps({ deliveryClientFor: () => deliveryClient });
      await expect(runOrchestratorPipeline(RUN_ID, deps)).resolves.toMatchObject({ finalStatus: 'DELIVERED_PASS' });
    });
  });

  it('refunds the unspent tool budget when a refund sender is configured', async () => {
    const refundCalls: Array<{ tokenAddress: string; toAddress: string; valueAtomic: bigint; nonce: number }> = [];
    const deps = baseDeps({
      refundSender: {
        async reserveNonce() {
          return 0;
        },
        async isNonceConsumed() {
          return false;
        },
        async sendRefund(input) {
          refundCalls.push(input);
          return `0x${'88'.repeat(32)}`;
        },
      },
    });

    const result = await runOrchestratorPipeline(RUN_ID, deps);
    expect(result.finalStatus).toBe('DELIVERED_PASS');
    // refundableToolBudgetAtomic (200) - the fake target's price (100) = 100 unspent
    expect(refundCalls).toEqual([
      {
        tokenAddress: '0x1000000000000000000000000000000000000001',
        toAddress: '0x2000000000000000000000000000000000000002',
        valueAtomic: 100n,
        nonce: 0,
      },
    ]);
  });

  it('never sends a refund when no refund sender is configured (still the default)', async () => {
    const deps = baseDeps();
    await expect(runOrchestratorPipeline(RUN_ID, deps)).resolves.toMatchObject({ finalStatus: 'DELIVERED_PASS' });
    // baseDeps() has no refundSender -- nothing to assert a call against, this just documents
    // that leaving it unset must not throw or block the run.
  });

  it('does not resend a refund that was already checkpointed on a resumed attempt', async () => {
    let refundCalls = 0;
    const deps = baseDeps({
      runRepository: fakeRunRepository(runAtStatus('PROCURING')),
      checkpointStore: fakeCheckpointStore({
        plan: { riskLevel: 'MEDIUM', scenarios: ['payment-proof-replay'], toolBudgetAtomic: '150', rationale: 'test' },
        paymentTransactionHash: `0x${'55'.repeat(32)}`,
        purchaseReceipt: paymentReceipt(),
        refundTransactionHash: `0x${'88'.repeat(32)}`,
      }),
      refundSender: {
        async reserveNonce() {
          return 0;
        },
        async isNonceConsumed() {
          return false;
        },
        async sendRefund() {
          refundCalls += 1;
          return `0x${'99'.repeat(32)}`;
        },
      },
    });

    await expect(runOrchestratorPipeline(RUN_ID, deps)).resolves.toMatchObject({ finalStatus: 'DELIVERED_PASS' });
    expect(refundCalls).toBe(0);
  });

  it('sends no refund when procurement spent exactly the refundable budget', async () => {
    const refundCalls: unknown[] = [];
    const deps = baseDeps(
      {
        riskClassifier: {
          async classify() {
            return {
              riskLevel: 'MEDIUM',
              proposedScenarios: ['payment-proof-replay'],
              proposedToolBudgetAtomic: '200',
              rationale: 'test',
            };
          },
        },
        refundSender: {
          async reserveNonce() {
            return 0;
          },
          async isNonceConsumed() {
            return false;
          },
          async sendRefund(input) {
            refundCalls.push(input);
            return `0x${'88'.repeat(32)}`;
          },
        },
      },
      '200',
    );

    await expect(runOrchestratorPipeline(RUN_ID, deps)).resolves.toMatchObject({ finalStatus: 'DELIVERED_PASS' });
    expect(refundCalls).toHaveLength(0);
  });

  it('rejects a run that is not FUNDED without mutating anything', async () => {
    const deps = baseDeps({ runRepository: fakeRunRepository(createDraftRun(RUN_ID, NOW.toISOString())) });
    await expect(runOrchestratorPipeline(RUN_ID, deps)).rejects.toThrow(RunNotReadyForOrchestrationError);
  });

  it('refuses to build a mandate around a loopback run target (SSRF guard)', async () => {
    const normal = fakeQuoteRepository();
    const deps = baseDeps({
      quoteRepository: {
        async findById(id) {
          const quote = await normal.findById(id);
          return quote ? { ...quote, request: { ...quote.request, x402Endpoint: 'http://localhost:3000/paid' } } : null;
        },
      },
    });
    const error = await runOrchestratorPipeline(RUN_ID, deps).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OrchestratorPipelineError);
    expect((error as OrchestratorPipelineError).advancedPastFunded).toBe(true);
  });

  it('wraps a mid-pipeline failure with advancedPastFunded=true', async () => {
    const deps = baseDeps({
      x402Payer: {
        payerAddress: '0x5000000000000000000000000000000000000005',
        async acquire() {
          throw new Error('RPC unreachable');
        },
      },
    });
    const error = await runOrchestratorPipeline(RUN_ID, deps).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OrchestratorPipelineError);
    expect((error as OrchestratorPipelineError).advancedPastFunded).toBe(true);
  });

  it('resumes from PROCURING without signing a second payment that was already checkpointed', async () => {
    let acquireCalls = 0;
    const deps = baseDeps({
      runRepository: fakeRunRepository(runAtStatus('PROCURING')),
      checkpointStore: fakeCheckpointStore({
        plan: { riskLevel: 'MEDIUM', scenarios: ['payment-proof-replay'], toolBudgetAtomic: '150', rationale: 'test' },
        paymentTransactionHash: PAYMENT_NONCE,
        purchaseReceipt: paymentReceipt(),
      }),
      x402Payer: {
        payerAddress: '0x5000000000000000000000000000000000000005',
        async acquire() {
          acquireCalls += 1;
          throw new Error('must not sign again');
        },
      },
    });
    const result = await runOrchestratorPipeline(RUN_ID, deps);
    expect(result.finalStatus).toBe('DELIVERED_PASS');
    expect(acquireCalls).toBe(0);
  });

  it('checkpoints the signed x402 payment before presenting it to the target', async () => {
    const checkpointStore = fakeCheckpointStore();
    const deps = baseDeps({
      checkpointStore,
      deliveryClientFor: () => ({
        async execute(input) {
          expect(checkpointStore.state.purchaseReceipt).toBe(input.paymentReceipt);
          expect(checkpointStore.state.paymentTransactionHash).toBeDefined();
          return {
            statusCode: input.idempotencyKey.endsWith(':replay') ? 409 : 200,
            deliveryConfirmed: !input.idempotencyKey.endsWith(':replay'),
            responseBodyHash: `0x${'44'.repeat(32)}`,
          };
        },
      }),
    });
    await expect(runOrchestratorPipeline(RUN_ID, deps)).resolves.toMatchObject({ finalStatus: 'DELIVERED_PASS' });
  });

  it("uses the checkpoint store's authoritative signature when it loses a concurrent-merge race", async () => {
    // Simulates a concurrent resumed attempt of this same run (e.g. a reclaimed job lease while
    // the original worker is still alive) already having reserved and checkpointed nonce 9 by the
    // time this attempt's own merge() call lands -- the real store's COALESCE would keep 9, not
    // this attempt's own locally-reserved 7.
    const base = fakeCheckpointStore();
    const checkpointStore: CheckpointStorePort = {
      load: base.load,
      async merge(runId, patch) {
        if (patch.purchaseReceipt !== undefined) {
          return base.merge(runId, {
            purchaseReceipt: paymentReceipt('100', `0x${'99'.repeat(32)}`),
            paymentTransactionHash: `0x${'99'.repeat(32)}`,
          });
        }
        return base.merge(runId, patch);
      },
    };
    const deps = baseDeps({
      checkpointStore,
      deliveryClientFor: () => ({
        async execute(input) {
          expect(input.paymentReceipt).toBe(paymentReceipt('100', `0x${'99'.repeat(32)}`));
          return {
            statusCode: input.idempotencyKey.endsWith(':replay') ? 409 : 200,
            deliveryConfirmed: !input.idempotencyKey.endsWith(':replay'),
            responseBodyHash: `0x${'44'.repeat(32)}`,
          };
        },
      }),
    });
    await expect(runOrchestratorPipeline(RUN_ID, deps)).resolves.toMatchObject({ finalStatus: 'DELIVERED_PASS' });
  });

  it('resumes from EVIDENCE_BUILDING without re-running the already-spent replay probe', async () => {
    let deliveryCalls = 0;
    const evidence = {
      scenarioId: 'payment-proof-replay',
      targetServiceId: 'service:demo',
      targetVersionHash: `0x${'11'.repeat(32)}`,
      policyHash: `0x${'22'.repeat(32)}`,
      paymentProofHash: `0x${'99'.repeat(32)}`,
      presentedReceiptHash: `0x${'aa'.repeat(32)}`,
      result: 'PASS' as const,
      attempts: [
        {
          phase: 'INITIAL' as const,
          requestHash: `0x${'bb'.repeat(32)}` as const,
          responseHash: `0x${'44'.repeat(32)}` as const,
          statusCode: 200,
          deliveryConfirmed: true,
        },
        {
          phase: 'REPLAY' as const,
          requestHash: `0x${'cc'.repeat(32)}` as const,
          responseHash: `0x${'44'.repeat(32)}` as const,
          statusCode: 409,
          deliveryConfirmed: false,
        },
      ],
    };
    const deps = baseDeps({
      runRepository: fakeRunRepository(runAtStatus('EVIDENCE_BUILDING')),
      checkpointStore: fakeCheckpointStore({
        plan: { riskLevel: 'MEDIUM', scenarios: ['payment-proof-replay'], toolBudgetAtomic: '150', rationale: 'test' },
        paymentTransactionHash: `0x${'55'.repeat(32)}`,
        purchaseReceipt: paymentReceipt(),
        evidence: [{ evidence, chainTransactionHash: `0x${'55'.repeat(32)}` }],
        startedAt: 1_000,
        completedAt: 1_010,
      }),
      deliveryClientFor: () => ({
        async execute() {
          deliveryCalls += 1;
          return { statusCode: 200, deliveryConfirmed: true, responseBodyHash: `0x${'44'.repeat(32)}` };
        },
      }),
    });
    const result = await runOrchestratorPipeline(RUN_ID, deps);
    expect(result.finalStatus).toBe('DELIVERED_PASS');
    expect(deliveryCalls).toBe(0);
  });

  it('resumes from ATTESTING without resubmitting to the append-only registry or re-storing evidence', async () => {
    let submitCalls = 0;
    const existingEvidencePack: EvidencePack = {
      runId: RUN_ID,
      evidenceRoot: `0x${'dd'.repeat(32)}`,
      toolReceiptRoot: `0x${'ee'.repeat(32)}`,
      uri: `ipfs://bafkfaketestfixture${RUN_ID}`,
      contentHash: `0x${'ff'.repeat(32)}`,
      publicManifest: { scenarios: ['payment-proof-replay'], result: 'PASS' },
      builtAt: NOW.toISOString(),
    };
    const evidencePackStore = fakeEvidencePackStore(existingEvidencePack);
    const deps = baseDeps({
      runRepository: fakeRunRepository(runAtStatus('ATTESTING')),
      checkpointStore: fakeCheckpointStore({
        plan: { riskLevel: 'MEDIUM', scenarios: ['payment-proof-replay'], toolBudgetAtomic: '150', rationale: 'test' },
        paymentTransactionHash: `0x${'55'.repeat(32)}`,
        purchaseReceipt: paymentReceipt(),
        evidence: [
          {
            evidence: {
              scenarioId: 'payment-proof-replay',
              targetServiceId: 'service:demo',
              targetVersionHash: `0x${'11'.repeat(32)}`,
              policyHash: `0x${'22'.repeat(32)}`,
              paymentProofHash: `0x${'99'.repeat(32)}`,
              presentedReceiptHash: `0x${'aa'.repeat(32)}`,
              result: 'PASS',
              attempts: [
                {
                  phase: 'INITIAL',
                  requestHash: `0x${'bb'.repeat(32)}`,
                  responseHash: `0x${'44'.repeat(32)}`,
                  statusCode: 200,
                  deliveryConfirmed: true,
                },
                {
                  phase: 'REPLAY',
                  requestHash: `0x${'cc'.repeat(32)}`,
                  responseHash: `0x${'44'.repeat(32)}`,
                  statusCode: 409,
                  deliveryConfirmed: false,
                },
              ],
            },
            chainTransactionHash: `0x${'55'.repeat(32)}`,
          },
        ],
        startedAt: 1_000,
        completedAt: 1_010,
        attestationTransactionHash: `0x${'77'.repeat(32)}`,
      }),
      evidencePackStore,
      attestor: {
        address: '0x7000000000000000000000000000000000000007',
        registryAddress: '0x07f6a55Fb88DD29e9A10802ce8d706dA26db8ddd',
        chainId: 48816,
        async submit() {
          submitCalls += 1;
          return `0x${'77'.repeat(32)}`;
        },
      },
    });
    const result = await runOrchestratorPipeline(RUN_ID, deps);
    expect(result).toMatchObject({ finalStatus: 'DELIVERED_PASS', attestationTransactionHash: `0x${'77'.repeat(32)}` });
    expect(submitCalls).toBe(0);
    expect(evidencePackStore.puts).toHaveLength(0);
    expect((deps.attestationStore as ReturnType<typeof fakeAttestationStore>).puts).toHaveLength(1);
  });
});

describe('finalizeRunAsInconclusive', () => {
  it('drives a stuck PROCURING run to DELIVERED_INCONCLUSIVE instead of leaving it there forever', async () => {
    // The bug this covers: a job that dead-letters only updated the job row, so a funded run kept
    // whatever status it failed at indefinitely -- the customer paid and never got any verdict.
    const deps = baseDeps({ runRepository: fakeRunRepository(runAtStatus('PROCURING')) });

    const result = await finalizeRunAsInconclusive(RUN_ID, deps, 'PIPELINE_RETRIES_EXHAUSTED');

    expect(result).toMatchObject({ runId: RUN_ID, finalStatus: 'DELIVERED_INCONCLUSIVE' });
    expect((deps.runRepository as ReturnType<typeof fakeRunRepository>).saved.map((event) => event.to)).toEqual([
      'EVIDENCE_BUILDING',
      'ATTESTING',
      'DELIVERED_INCONCLUSIVE',
    ]);
  });

  it('publishes an evidence pack that says INCONCLUSIVE and carries no fabricated tool receipts', async () => {
    const evidencePackStore = fakeEvidencePackStore();
    const deps = baseDeps({ runRepository: fakeRunRepository(runAtStatus('PROCURING')), evidencePackStore });

    await finalizeRunAsInconclusive(RUN_ID, deps, 'PIPELINE_RETRIES_EXHAUSTED');

    expect(evidencePackStore.puts).toHaveLength(1);
    expect(evidencePackStore.puts[0]?.publicManifest).toMatchObject({ result: 'INCONCLUSIVE', toolReceipts: [] });
  });

  it('attests INCONCLUSIVE on chain, so the verdict is publicly verifiable like any other', async () => {
    const attestationStore = fakeAttestationStore();
    const deps = baseDeps({ runRepository: fakeRunRepository(runAtStatus('PROCURING')), attestationStore });

    await finalizeRunAsInconclusive(RUN_ID, deps, 'PIPELINE_RETRIES_EXHAUSTED');

    expect(attestationStore.puts).toHaveLength(1);
  });

  it('reports INCONCLUSIVE even when the scenarios it did manage to run all passed', async () => {
    // Partial coverage is not a pass: the run stopped early, so those green scenarios say nothing
    // about the checks that never got to run.
    const evidencePackStore = fakeEvidencePackStore();
    const deps = baseDeps({
      runRepository: fakeRunRepository(runAtStatus('EXECUTING')),
      evidencePackStore,
      checkpointStore: fakeCheckpointStore({
        plan: { riskLevel: 'MEDIUM', scenarios: ['payment-proof-replay'], toolBudgetAtomic: '150', rationale: 'test' },
        evidence: [passedScenario()],
        startedAt: 1,
        completedAt: 2,
      }),
    });

    await finalizeRunAsInconclusive(RUN_ID, deps, 'PIPELINE_RETRIES_EXHAUSTED');

    expect(evidencePackStore.puts[0]?.publicManifest.result).toBe('INCONCLUSIVE');
  });

  it('skips a half-written scenario rather than failing the whole finalization on it', async () => {
    // A run killed mid-execution can hold an attempt recorded before any response came back.
    // That must not put the run back into the stuck state this function exists to rescue it from.
    const evidencePackStore = fakeEvidencePackStore();
    const deps = baseDeps({
      runRepository: fakeRunRepository(runAtStatus('EXECUTING')),
      evidencePackStore,
      checkpointStore: fakeCheckpointStore({
        plan: { riskLevel: 'MEDIUM', scenarios: ['payment-proof-replay'], toolBudgetAtomic: '150', rationale: 'test' },
        evidence: [
          {
            evidence: {
              scenarioId: 'payment-proof-replay',
              result: 'INCONCLUSIVE',
              attempts: [{ phase: 'INITIAL', requestHash: `0x${'11'.repeat(32)}` }],
            },
            chainTransactionHash: `0x${'22'.repeat(32)}`,
          },
        ],
        startedAt: 1,
        completedAt: 2,
      }),
    });

    await expect(finalizeRunAsInconclusive(RUN_ID, deps, 'PIPELINE_RETRIES_EXHAUSTED')).resolves.toMatchObject({
      finalStatus: 'DELIVERED_INCONCLUSIVE',
    });
    expect(evidencePackStore.puts[0]?.publicManifest.toolReceipts).toHaveLength(0);
  });

  it("stamps the attestation with the run's own times, never a wall clock the chain has not reached", async () => {
    // The registry reverts with InvalidCompletionTime when completedAt is above block.timestamp.
    // Finalizing an old run against "now" hits that on any clock skew, and misdates the run too.
    let submitted: { completedAt: number } | undefined;
    const deps = baseDeps({
      runRepository: fakeRunRepository(runAtStatus('PROCURING')),
      attestor: {
        address: '0x6000000000000000000000000000000000000006',
        registryAddress: '0x07f6a55Fb88DD29e9A10802ce8d706dA26db8ddd',
        chainId: 48816,
        async submit(input: { completedAt: number }) {
          submitted = input;
          return `0x${'ab'.repeat(32)}` as const;
        },
      },
      now: () => new Date('2027-01-01T00:00:00.000Z'),
    });

    await finalizeRunAsInconclusive(RUN_ID, deps, 'PIPELINE_RETRIES_EXHAUSTED');

    expect(submitted?.completedAt).toBe(Math.floor(NOW.getTime() / 1_000));
  });

  it('leaves an unfunded run alone -- there is nothing paid for to attest', async () => {
    const deps = baseDeps({ runRepository: fakeRunRepository(createDraftRun(RUN_ID, NOW.toISOString())) });

    await expect(finalizeRunAsInconclusive(RUN_ID, deps, 'UNEXPECTED_RUN_STATE')).resolves.toBeNull();
    expect((deps.runRepository as ReturnType<typeof fakeRunRepository>).saved).toHaveLength(0);
  });

  it('leaves an already-delivered run alone, so a repeat call cannot re-attest it', async () => {
    const deps = baseDeps({ runRepository: fakeRunRepository(deliveredRun()) });

    await expect(finalizeRunAsInconclusive(RUN_ID, deps, 'PIPELINE_RETRIES_EXHAUSTED')).resolves.toBeNull();
    expect((deps.runRepository as ReturnType<typeof fakeRunRepository>).saved).toHaveLength(0);
  });
});

function deliveredRun(): RunAggregate {
  let run = runAtStatus('ATTESTING');
  const result = transitionRun(run, {
    actor: 'ATTESTOR',
    expectedRevision: run.revision,
    idempotencyKey: 'setup:DELIVERED_FAIL',
    occurredAt: NOW.toISOString(),
    to: 'DELIVERED_FAIL',
  });
  run = result.run;
  return run;
}

function passedScenario() {
  return {
    evidence: {
      scenarioId: 'payment-proof-replay',
      result: 'PASS' as const,
      attempts: [
        {
          phase: 'INITIAL' as const,
          requestHash: `0x${'11'.repeat(32)}` as const,
          responseHash: `0x${'33'.repeat(32)}` as const,
          statusCode: 200,
          deliveryConfirmed: true,
        },
      ],
    },
    chainTransactionHash: `0x${'22'.repeat(32)}` as const,
  };
}

describe('target chain routing', () => {
  it('refuses a target on a chain this worker has no payer for, rather than paying on its own chain', async () => {
    // Falling through to the home payer would sign an authorization naming chain 48816 for a target
    // that settles on 56 -- unsettleable, and it would look like the target's fault.
    const deps = baseDeps({
      quoteRepository: {
        async findById() {
          const quote = await fakeQuoteRepository().findById('quote_1');
          return quote ? ({ ...quote, targetChainId: 56 } as typeof quote) : null;
        },
      },
    });

    // Surfaced as a denial, not a transient failure: no amount of retrying grows a payer.
    await expect(runOrchestratorPipeline(RUN_ID, deps)).rejects.toMatchObject({
      name: 'ProcurementDeniedError',
      denialCodes: ['NO_PAYER_FOR_TARGET_CHAIN'],
    });
  });

  it('runs a same-chain target through the ordinary procurement path', async () => {
    const deps = baseDeps({
      quoteRepository: {
        async findById() {
          const quote = await fakeQuoteRepository().findById('quote_1');
          return quote ? ({ ...quote, targetChainId: 48816 } as typeof quote) : null;
        },
      },
    });

    await expect(runOrchestratorPipeline(RUN_ID, deps)).resolves.toMatchObject({
      finalStatus: 'DELIVERED_PASS',
    });
  });
});
