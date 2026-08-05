import type { AttestationRecord, EvidencePack, OrchestratorRunCheckpoint } from '@shipyard402/persistence-postgres';
import type { RunAggregate, RunStatus, RunTransitionedEvent } from '@shipyard402/run-domain';
import { createDraftRun, transitionRun } from '@shipyard402/run-domain';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
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

function fakeCheckpointStore(initial: OrchestratorRunCheckpoint = {}): CheckpointStorePort & { state: OrchestratorRunCheckpoint } {
  const store = {
    state: initial,
    async load(_runId: string) {
      return store.state;
    },
    async merge(_runId: string, patch: OrchestratorRunCheckpoint) {
      store.state = { ...store.state, ...patch };
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

function fakeAttestationStore(existing: AttestationRecord | null = null): AttestationStorePort & { puts: AttestationRecord[] } {
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

function baseDeps(overrides: Partial<OrchestratorPipelineDependencies> = {}): OrchestratorPipelineDependencies {
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
    demoTarget: {
      baseUrl: 'https://demo-target.shipyard-test.internal',
      host: 'demo-target.shipyard-test.internal',
      toolAgentId: 'agent:demo-target',
      receivingAddress: '0x4000000000000000000000000000000000000004',
      minimumAtomicAmount: '100',
      minimumConfirmations: 1,
      toolVersion: 'x402-demo-target@0.1.0',
      chainId: 48816,
    },
    deliveryClient: {
      async execute(input) {
        return {
          statusCode: input.idempotencyKey.endsWith(':replay') ? 409 : 200,
          deliveryConfirmed: !input.idempotencyKey.endsWith(':replay'),
          responseBodyHash: `0x${'44'.repeat(32)}`,
        };
      },
    },
    paymentSender: {
      async sendPayment() {
        return `0x${'55'.repeat(32)}`;
      },
      async waitForConfirmation(transactionHash) {
        return { transactionHash, confirmations: 1 };
      },
    },
    purchaseClient: {
      async purchase() {
        return { receipt: 'fake-earned-receipt-token' };
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
      'ANALYZING', 'PLAN_COMPILED', 'PROCURING', 'EXECUTING', 'EVIDENCE_BUILDING', 'ATTESTING', 'DELIVERED_PASS',
    ]);
  });

  it('delivers DELIVERED_FAIL when the target accepts a replayed payment receipt', async () => {
    const deps = baseDeps({
      deliveryClient: {
        async execute() {
          return { statusCode: 200, deliveryConfirmed: true, responseBodyHash: `0x${'44'.repeat(32)}` };
        },
      },
    });
    const result = await runOrchestratorPipeline(RUN_ID, deps);
    expect(result.finalStatus).toBe('DELIVERED_FAIL');
  });

  it('rejects a run that is not FUNDED without mutating anything', async () => {
    const deps = baseDeps({ runRepository: fakeRunRepository(createDraftRun(RUN_ID, NOW.toISOString())) });
    await expect(runOrchestratorPipeline(RUN_ID, deps)).rejects.toThrow(RunNotReadyForOrchestrationError);
  });

  it('refuses to build a mandate around a loopback demo-target host (SSRF guard)', async () => {
    const deps = baseDeps({
      demoTarget: { ...baseDeps().demoTarget, host: 'localhost' },
    });
    const error = await runOrchestratorPipeline(RUN_ID, deps).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OrchestratorPipelineError);
    expect((error as OrchestratorPipelineError).advancedPastFunded).toBe(true);
  });

  it('wraps a mid-pipeline failure with advancedPastFunded=true', async () => {
    const deps = baseDeps({
      paymentSender: {
        async sendPayment() {
          throw new Error('RPC unreachable');
        },
        async waitForConfirmation(transactionHash) {
          return { transactionHash, confirmations: 1 };
        },
      },
    });
    const error = await runOrchestratorPipeline(RUN_ID, deps).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OrchestratorPipelineError);
    expect((error as OrchestratorPipelineError).advancedPastFunded).toBe(true);
  });

  it('resumes from PROCURING without re-sending a payment that was already checkpointed', async () => {
    let sendPaymentCalls = 0;
    const deps = baseDeps({
      runRepository: fakeRunRepository(runAtStatus('PROCURING')),
      checkpointStore: fakeCheckpointStore({
        plan: { riskLevel: 'MEDIUM', scenarios: ['payment-proof-replay'], toolBudgetAtomic: '150', rationale: 'test' },
        paymentTransactionHash: `0x${'55'.repeat(32)}`,
      }),
      paymentSender: {
        async sendPayment() {
          sendPaymentCalls += 1;
          return `0x${'55'.repeat(32)}`;
        },
        async waitForConfirmation(transactionHash) {
          return { transactionHash, confirmations: 1 };
        },
      },
    });
    const result = await runOrchestratorPipeline(RUN_ID, deps);
    expect(result.finalStatus).toBe('DELIVERED_PASS');
    expect(sendPaymentCalls).toBe(0);
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
        { phase: 'INITIAL' as const, requestHash: `0x${'bb'.repeat(32)}` as const, responseHash: `0x${'44'.repeat(32)}` as const, statusCode: 200, deliveryConfirmed: true },
        { phase: 'REPLAY' as const, requestHash: `0x${'cc'.repeat(32)}` as const, responseHash: `0x${'44'.repeat(32)}` as const, statusCode: 409, deliveryConfirmed: false },
      ],
    };
    const deps = baseDeps({
      runRepository: fakeRunRepository(runAtStatus('EVIDENCE_BUILDING')),
      checkpointStore: fakeCheckpointStore({
        plan: { riskLevel: 'MEDIUM', scenarios: ['payment-proof-replay'], toolBudgetAtomic: '150', rationale: 'test' },
        paymentTransactionHash: `0x${'55'.repeat(32)}`,
        purchaseReceipt: 'fake-earned-receipt-token',
        evidence,
        startedAt: 1_000,
        completedAt: 1_010,
      }),
      deliveryClient: {
        async execute() {
          deliveryCalls += 1;
          return { statusCode: 200, deliveryConfirmed: true, responseBodyHash: `0x${'44'.repeat(32)}` };
        },
      },
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
        purchaseReceipt: 'fake-earned-receipt-token',
        evidence: {
          scenarioId: 'payment-proof-replay',
          targetServiceId: 'service:demo',
          targetVersionHash: `0x${'11'.repeat(32)}`,
          policyHash: `0x${'22'.repeat(32)}`,
          paymentProofHash: `0x${'99'.repeat(32)}`,
          presentedReceiptHash: `0x${'aa'.repeat(32)}`,
          result: 'PASS',
          attempts: [
            { phase: 'INITIAL', requestHash: `0x${'bb'.repeat(32)}`, responseHash: `0x${'44'.repeat(32)}`, statusCode: 200, deliveryConfirmed: true },
            { phase: 'REPLAY', requestHash: `0x${'cc'.repeat(32)}`, responseHash: `0x${'44'.repeat(32)}`, statusCode: 409, deliveryConfirmed: false },
          ],
        },
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
