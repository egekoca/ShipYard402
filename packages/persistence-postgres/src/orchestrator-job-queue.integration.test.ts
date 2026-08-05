import { createHash, randomUUID } from 'node:crypto';

import { QuoteEngine } from '@shipyard402/quote-engine';
import { createDraftRun, transitionRun } from '@shipyard402/run-domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresAttestationStore } from './attestation-store.js';
import { PostgresEvidencePackStore } from './evidence-pack-store.js';
import { PostgresOrchestratorCheckpointStore } from './orchestrator-checkpoint-store.js';
import { PostgresOrchestratorJobQueue } from './orchestrator-job-queue.js';
import { PostgresQuoteRepository, PostgresRunRepository } from './api-repositories.js';
import { createShipyardPool } from './pool.js';

const databaseUrl = process.env['TEST_DATABASE_URL'];
const organizationId = randomUUID();
const serviceId = randomUUID();
const releaseId = randomUUID();
const policyId = randomUUID();
const fixtureSuffix = randomUUID();
const targetServiceId = `service:orchestrator-jobs:${fixtureSuffix}`;
const x402Endpoint = `https://target.example/${fixtureSuffix}/paid`;
const openApiUrl = `https://target.example/${fixtureSuffix}/openapi.json`;
const runId = `run_orchestrator_${fixtureSuffix}`;

const pool = databaseUrl
  ? createShipyardPool({ connectionString: databaseUrl, useTls: false, maximumConnections: 4 })
  : null;

describe.skipIf(!databaseUrl)('PostgreSQL orchestrator job queue and evidence/attestation stores', () => {
  beforeAll(async () => {
    if (!pool) throw new Error('TEST_DATABASE_URL is required');
    await pool.query(
      `INSERT INTO organizations (id, name, billing_wallet) VALUES ($1, $2, $3)`,
      [organizationId, `Orchestrator jobs ${fixtureSuffix}`, hexBuffer('0x2000000000000000000000000000000000000002')],
    );
    await pool.query(
      `INSERT INTO services (id, organization_id, external_service_id, name, x402_endpoint, openapi_url)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [serviceId, organizationId, targetServiceId, 'Orchestrator jobs integration service', x402Endpoint, openApiUrl],
    );
    await pool.query(
      `INSERT INTO releases (id, service_id, version, version_hash, manifest_hash)
       VALUES ($1, $2, 'integration', $3, $4)`,
      [releaseId, serviceId, hexBuffer(digest(`release:${fixtureSuffix}`)), hexBuffer(digest(`manifest:${fixtureSuffix}`))],
    );
    await pool.query(
      `INSERT INTO policies (id, name, version, policy_hash, mandatory_scenarios, mandate_template)
       VALUES ($1, $2, 'integration', $3, '[]'::jsonb, '{}'::jsonb)`,
      [policyId, `orchestrator-jobs-${fixtureSuffix}`, hexBuffer(digest(`policy:${fixtureSuffix}`))],
    );

    const now = new Date();
    const quote = new QuoteEngine({
      pricingStatus: 'HYPOTHESIS',
      baseOrchestrationFeeAtomic: '100',
      mandatoryToolBudgetAtomic: '100',
      dynamicToolBudgetAtomic: '100',
      modelInfrastructureReserveAtomic: '100',
      chainStorageReserveAtomic: '100',
      riskSupportReserveAtomic: '100',
      quoteTtlSeconds: 900,
    }, () => fixtureSuffix).createQuote({
      organizationId,
      requesterAddress: '0x2000000000000000000000000000000000000002',
      targetAgentId: 'agent:external',
      targetServiceId,
      targetVersionHash: digest(`release:${fixtureSuffix}`),
      policyHash: digest(`policy:${fixtureSuffix}`),
      x402Endpoint,
      openApiUrl,
      maximumCustomerBudgetAtomic: '1000',
    }, {
      environment: 'mainnet',
      merchantId: 'orchestrator-jobs-merchant',
      mode: 'ERC20_DIRECT',
      chainId: 2345,
      tokenAddress: '0x1000000000000000000000000000000000000001',
      tokenSymbol: 'ORCH_ONLY',
      tokenDecimals: 6,
      receivingAddress: '0x3000000000000000000000000000000000000003',
      minimumAtomicAmount: '1',
      maximumAtomicAmount: '100000000',
      discoveredAt: now.toISOString(),
      source: 'PORTAL_REVIEW',
    }, now);
    await new PostgresQuoteRepository(pool).save(quote);

    const draft = createDraftRun(runId, now.toISOString());
    const quoted = transitionRun(draft, {
      actor: 'QUOTE_ENGINE',
      expectedRevision: 0,
      idempotencyKey: `quoted:${fixtureSuffix}`,
      occurredAt: now.toISOString(),
      to: 'QUOTED',
    });
    if (!quoted.event) throw new Error('Expected QUOTED domain event');
    await new PostgresRunRepository(pool).save({
      aggregate: quoted.run,
      quoteId: quote.id,
      requestIdempotencyKey: `request:${fixtureSuffix}`,
      uncommittedEvent: quoted.event,
    });

    await pool.query(`INSERT INTO orchestrator_jobs (run_id) VALUES ($1)`, [runId]);
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DELETE FROM orchestrator_run_checkpoints WHERE run_id = $1`, [runId]);
    await pool.query(`DELETE FROM attestations WHERE run_id = $1`, [runId]);
    await pool.query(`DELETE FROM evidence_packs WHERE run_id = $1`, [runId]);
    await pool.query(`DELETE FROM orchestrator_jobs WHERE run_id = $1`, [runId]);
    await pool.query(`DELETE FROM run_events WHERE run_id = $1`, [runId]);
    await pool.query(`DELETE FROM runs WHERE id = $1`, [runId]);
    await pool.query(`DELETE FROM quotes WHERE organization_id = $1`, [organizationId]);
    await pool.query(`DELETE FROM releases WHERE id = $1`, [releaseId]);
    await pool.query(`DELETE FROM services WHERE id = $1`, [serviceId]);
    await pool.query(`DELETE FROM policies WHERE id = $1`, [policyId]);
    await pool.query(`DELETE FROM organizations WHERE id = $1`, [organizationId]);
    await pool.end();
  });

  it('claims, retries, and completes an orchestrator job through its full lease lifecycle', async () => {
    if (!pool) throw new Error('TEST_DATABASE_URL is required');
    const queue = new PostgresOrchestratorJobQueue(pool);

    const firstClaim = await queue.claimNext({ workerId: 'integration-worker', leaseDurationSeconds: 30 });
    expect(firstClaim).toMatchObject({ runId, attempt: 1, maximumAttempts: 8 });
    await expect(queue.claimNext({
      workerId: 'competing-worker', leaseDurationSeconds: 30,
    })).resolves.toBeNull();

    await queue.markRetry(firstClaim!, 0, 'RISK_CLASSIFICATION_UNAVAILABLE');
    const retryClaim = await queue.claimNext({ workerId: 'integration-worker', leaseDurationSeconds: 30 });
    expect(retryClaim).toMatchObject({ runId, attempt: 2, maximumAttempts: 8 });

    await queue.markCompleted(retryClaim!);
    const completedJob = await queue.findByRunId(runId);
    expect(completedJob).toMatchObject({ status: 'COMPLETED', attempts: 2 });
    expect(completedJob).not.toHaveProperty('lastErrorCode');
  });

  it('round-trips an evidence pack through PostgresEvidencePackStore', async () => {
    if (!pool) throw new Error('TEST_DATABASE_URL is required');
    const store = new PostgresEvidencePackStore(pool);
    const builtAt = new Date().toISOString();
    await store.put({
      runId,
      evidenceRoot: `0x${'cc'.repeat(32)}`,
      toolReceiptRoot: `0x${'dd'.repeat(32)}`,
      uri: `https://api.example/v1/runs/${runId}/evidence`,
      contentHash: `0x${'ee'.repeat(32)}`,
      publicManifest: { scenarios: ['payment-proof-replay'], result: 'PASS' },
      builtAt,
    });

    await expect(store.getByRunId(runId)).resolves.toMatchObject({
      runId,
      evidenceRoot: `0x${'cc'.repeat(32)}`,
      toolReceiptRoot: `0x${'dd'.repeat(32)}`,
      uri: `https://api.example/v1/runs/${runId}/evidence`,
      contentHash: `0x${'ee'.repeat(32)}`,
      publicManifest: { scenarios: ['payment-proof-replay'], result: 'PASS' },
    });
  });

  it('round-trips an attestation record through PostgresAttestationStore', async () => {
    if (!pool) throw new Error('TEST_DATABASE_URL is required');
    const store = new PostgresAttestationStore(pool);
    const submittedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
    await store.put({
      runId,
      registryAddress: '0x07f6a55fb88dd29e9a10802ce8d706da26db8ddd',
      chainId: 48816,
      transactionHash: `0x${'ff'.repeat(32)}`,
      attestor: '0x8eb7e837242d6ee3baa274f1750c644bf3e08c10',
      expiresAt,
      submittedAt,
    });

    await expect(store.getByRunId(runId)).resolves.toMatchObject({
      runId,
      registryAddress: '0x07f6a55fb88dd29e9a10802ce8d706da26db8ddd',
      chainId: 48816,
      transactionHash: `0x${'ff'.repeat(32)}`,
      attestor: '0x8eb7e837242d6ee3baa274f1750c644bf3e08c10',
    });
  });

  it('accumulates an orchestrator checkpoint across independent merges without clobbering earlier fields', async () => {
    if (!pool) throw new Error('TEST_DATABASE_URL is required');
    const store = new PostgresOrchestratorCheckpointStore(pool);

    await expect(store.load(runId)).resolves.toEqual({});

    await store.merge(runId, {
      plan: { riskLevel: 'MEDIUM', scenarios: ['payment-proof-replay'], toolBudgetAtomic: '150', rationale: 'test' },
    });
    await store.merge(runId, { paymentTransactionHash: `0x${'11'.repeat(32)}` });

    await expect(store.load(runId)).resolves.toMatchObject({
      plan: { riskLevel: 'MEDIUM', scenarios: ['payment-proof-replay'], toolBudgetAtomic: '150', rationale: 'test' },
      paymentTransactionHash: `0x${'11'.repeat(32)}`,
    });

    // A merge must never overwrite an already-checkpointed field — this is what makes a resumed
    // pipeline safe to re-derive the same "already sent" payment hash instead of double-spending.
    await store.merge(runId, { paymentTransactionHash: `0x${'22'.repeat(32)}` });
    await expect(store.load(runId)).resolves.toMatchObject({ paymentTransactionHash: `0x${'11'.repeat(32)}` });
  });
});

function digest(value: string): `0x${string}` {
  return `0x${createHash('sha256').update(value).digest('hex')}`;
}

function hexBuffer(value: string): Buffer {
  return Buffer.from(value.slice(2), 'hex');
}
