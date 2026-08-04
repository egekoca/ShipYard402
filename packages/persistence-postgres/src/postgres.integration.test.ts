import { createHash, randomUUID } from 'node:crypto';

import { QuoteEngine } from '@shipyard402/quote-engine';
import { createDraftRun, transitionRun } from '@shipyard402/run-domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresQuoteRepository, PostgresRunRepository, type ApiRunRecord } from './api-repositories.js';
import { PostgresPaymentReconciliationJobQueue } from './payment-job-queue.js';
import { createShipyardPool } from './pool.js';

const databaseUrl = process.env['TEST_DATABASE_URL'];
const organizationId = randomUUID();
const serviceId = randomUUID();
const releaseId = randomUUID();
const policyId = randomUUID();
const fixtureSuffix = randomUUID();
const targetVersionHash = digest(`release:${fixtureSuffix}`);
const manifestHash = digest(`manifest:${fixtureSuffix}`);
const policyHash = digest(`policy:${fixtureSuffix}`);
const targetServiceId = `service:postgres:${fixtureSuffix}`;
const x402Endpoint = `https://target.example/${fixtureSuffix}/paid`;
const openApiUrl = `https://target.example/${fixtureSuffix}/openapi.json`;
const runId = `run_${fixtureSuffix}`;

const pool = databaseUrl
  ? createShipyardPool({ connectionString: databaseUrl, useTls: false, maximumConnections: 4 })
  : null;

describe.skipIf(!databaseUrl)('PostgreSQL API persistence integration', () => {
  beforeAll(async () => {
    if (!pool) throw new Error('TEST_DATABASE_URL is required');
    await pool.query(
      `INSERT INTO organizations (id, name, billing_wallet) VALUES ($1, $2, $3)`,
      [organizationId, `Integration ${fixtureSuffix}`, hexBuffer('0x2000000000000000000000000000000000000002')],
    );
    await pool.query(
      `INSERT INTO services (
        id, organization_id, external_service_id, name, x402_endpoint, openapi_url
      ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [serviceId, organizationId, targetServiceId, 'PostgreSQL integration service', x402Endpoint, openApiUrl],
    );
    await pool.query(
      `INSERT INTO releases (id, service_id, version, version_hash, manifest_hash)
       VALUES ($1, $2, 'integration', $3, $4)`,
      [releaseId, serviceId, hexBuffer(targetVersionHash), hexBuffer(manifestHash)],
    );
    await pool.query(
      `INSERT INTO policies (id, name, version, policy_hash, mandatory_scenarios, mandate_template)
       VALUES ($1, $2, 'integration', $3, '[]'::jsonb, '{}'::jsonb)`,
      [policyId, `integration-${fixtureSuffix}`, hexBuffer(policyHash)],
    );
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DELETE FROM payment_reconciliation_jobs WHERE run_id = $1`, [runId]);
    await pool.query(`DELETE FROM outbox_events WHERE aggregate_id = $1`, [runId]);
    await pool.query(`DELETE FROM run_events WHERE run_id = $1`, [runId]);
    await pool.query(`DELETE FROM runs WHERE id = $1`, [runId]);
    await pool.query(`DELETE FROM quotes WHERE organization_id = $1`, [organizationId]);
    await pool.query(`DELETE FROM releases WHERE id = $1`, [releaseId]);
    await pool.query(`DELETE FROM services WHERE id = $1`, [serviceId]);
    await pool.query(`DELETE FROM policies WHERE id = $1`, [policyId]);
    await pool.query(`DELETE FROM organizations WHERE id = $1`, [organizationId]);
    await pool.end();
  });

  it('persists a quote and run, then leases its durable payment reconciliation job', async () => {
    if (!pool) throw new Error('TEST_DATABASE_URL is required');
    const quoteRepository = new PostgresQuoteRepository(pool);
    const firstRunRepository = new PostgresRunRepository(pool);
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
      targetVersionHash,
      policyHash,
      x402Endpoint,
      openApiUrl,
      maximumCustomerBudgetAtomic: '1000',
    }, {
      environment: 'mainnet',
      merchantId: 'integration-merchant',
      mode: 'ERC20_DIRECT',
      chainId: 2345,
      tokenAddress: '0x1000000000000000000000000000000000000001',
      tokenSymbol: 'INTEGRATION_ONLY',
      tokenDecimals: 6,
      receivingAddress: '0x3000000000000000000000000000000000000003',
      minimumAtomicAmount: '1',
      maximumAtomicAmount: '100000000',
      discoveredAt: now.toISOString(),
      source: 'PORTAL_REVIEW',
    }, now);

    await quoteRepository.save(quote);
    await expect(new PostgresQuoteRepository(pool).findById(quote.id)).resolves.toEqual(quote);

    const draft = createDraftRun(runId, now.toISOString());
    const transition = transitionRun(draft, {
      actor: 'QUOTE_ENGINE',
      expectedRevision: 0,
      idempotencyKey: `quoted:${fixtureSuffix}`,
      occurredAt: now.toISOString(),
      to: 'QUOTED',
    });
    if (!transition.event) throw new Error('Expected QUOTED domain event');
    const record: ApiRunRecord = {
      aggregate: transition.run,
      quoteId: quote.id,
      requestIdempotencyKey: `request:${fixtureSuffix}`,
      uncommittedEvent: transition.event,
    };
    await firstRunRepository.save(record);

    const restartedRepository = new PostgresRunRepository(pool);
    const recovered = await restartedRepository.findByRequestIdempotencyKey(record.requestIdempotencyKey);
    expect(recovered).toMatchObject({
      aggregate: { id: runId, status: 'QUOTED', revision: 1 },
      quoteId: quote.id,
      requestIdempotencyKey: record.requestIdempotencyKey,
    });
    if (!recovered) throw new Error('Expected persisted QUOTED run');
    const paymentRequired = transitionRun(recovered.aggregate, {
      actor: 'MERCHANT_GATEWAY',
      expectedRevision: recovered.aggregate.revision,
      idempotencyKey: `payment-required:${fixtureSuffix}`,
      occurredAt: new Date(now.getTime() + 1_000).toISOString(),
      to: 'PAYMENT_REQUIRED',
    });
    if (!paymentRequired.event) throw new Error('Expected PAYMENT_REQUIRED domain event');
    await restartedRepository.save({
      ...recovered,
      aggregate: paymentRequired.run,
      uncommittedEvent: paymentRequired.event,
    }, recovered.aggregate.revision);

    const queue = new PostgresPaymentReconciliationJobQueue(pool);
    const firstClaim = await queue.claimNext({ workerId: 'integration-worker', leaseDurationSeconds: 30 });
    expect(firstClaim).toMatchObject({ runId, attempt: 1, maximumAttempts: 8 });
    await expect(queue.claimNext({
      workerId: 'competing-worker', leaseDurationSeconds: 30,
    })).resolves.toBeNull();
    await queue.markRetry(firstClaim!, 0, 'PAYMENT_NOT_READY');
    const retryClaim = await queue.claimNext({ workerId: 'integration-worker', leaseDurationSeconds: 30 });
    expect(retryClaim).toMatchObject({ runId, attempt: 2, maximumAttempts: 8 });
    await queue.markCompleted(retryClaim!);
    const completedJob = await queue.findByRunId(runId);
    expect(completedJob).toMatchObject({ status: 'COMPLETED', attempts: 2 });
    expect(completedJob).not.toHaveProperty('lastErrorCode');
    await expect(pool.query(
      `SELECT count(*)::int AS count FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'run.transitioned'`,
      [runId],
    )).resolves.toMatchObject({ rows: [{ count: 2 }] });
  });
});

function digest(value: string): `0x${string}` {
  return `0x${createHash('sha256').update(value).digest('hex')}`;
}

function hexBuffer(value: string): Buffer {
  return Buffer.from(value.slice(2), 'hex');
}
