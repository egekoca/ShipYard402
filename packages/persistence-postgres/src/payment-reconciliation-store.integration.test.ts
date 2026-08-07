import { createHash, randomUUID } from 'node:crypto';

import { QuoteEngine } from '@shipyard402/quote-engine';
import { createDraftRun, transitionRun, type RunAggregate } from '@shipyard402/run-domain';
import type { MerchantOrder, MerchantPaymentProof, NormalizedTransactionReceipt } from '@shipyard402/x402-payments';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresQuoteRepository, PostgresRunRepository } from './api-repositories.js';
import { PostgresFlowOrderContextStore } from './flow-order-context-store.js';
import { PostgresPaymentReconciliationStore } from './payment-reconciliation-store.js';
import { createShipyardPool } from './pool.js';

const databaseUrl = process.env['TEST_DATABASE_URL'];
const organizationId = randomUUID();
const serviceId = randomUUID();
const releaseId = randomUUID();
const policyId = randomUUID();
const fixtureSuffix = randomUUID();
const targetServiceId = `service:duplicate-charge:${fixtureSuffix}`;
const x402Endpoint = `https://target.example/${fixtureSuffix}/paid`;
const openApiUrl = `https://target.example/${fixtureSuffix}/openapi.json`;
const runIds: string[] = [];

const pool = databaseUrl
  ? createShipyardPool({ connectionString: databaseUrl, useTls: false, maximumConnections: 4 })
  : null;

describe.skipIf(!databaseUrl)('PostgreSQL duplicate-charge and idempotency enforcement', () => {
  beforeAll(async () => {
    if (!pool) throw new Error('TEST_DATABASE_URL is required');
    await pool.query(
      // billing_wallet is now unique per organization (see 0009_organizations_unique_billing_wallet.sql)
      // -- each integration test file needs its own synthetic wallet, not the shared fixture address
      // used elsewhere in this file for the payer/requester address.
      `INSERT INTO organizations (id, name, billing_wallet) VALUES ($1, $2, $3)`,
      [organizationId, `Duplicate-charge ${fixtureSuffix}`, hexBuffer(digest(`org-wallet:${fixtureSuffix}`).slice(0, 42) as `0x${string}`)],
    );
    await pool.query(
      `INSERT INTO services (
        id, organization_id, external_service_id, name, x402_endpoint, openapi_url
      ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [serviceId, organizationId, targetServiceId, 'Duplicate-charge integration service', x402Endpoint, openApiUrl],
    );
    await pool.query(
      `INSERT INTO releases (id, service_id, version, version_hash, manifest_hash)
       VALUES ($1, $2, 'integration', $3, $4)`,
      [releaseId, serviceId, hexBuffer(digest(`release:${fixtureSuffix}`)), hexBuffer(digest(`manifest:${fixtureSuffix}`))],
    );
    await pool.query(
      `INSERT INTO policies (id, name, version, policy_hash, mandatory_scenarios, mandate_template)
       VALUES ($1, $2, 'integration', $3, '[]'::jsonb, '{}'::jsonb)`,
      [policyId, `duplicate-charge-${fixtureSuffix}`, hexBuffer(digest(`policy:${fixtureSuffix}`))],
    );
  });

  afterAll(async () => {
    if (!pool) return;
    for (const runId of runIds) {
      await pool.query(`DELETE FROM orchestrator_jobs WHERE run_id = $1`, [runId]);
      await pool.query(`DELETE FROM payment_reconciliation_jobs WHERE run_id = $1`, [runId]);
      await pool.query(`DELETE FROM payment_receipts WHERE run_id = $1`, [runId]);
      await pool.query(`DELETE FROM payment_orders WHERE run_id = $1`, [runId]);
      await pool.query(`DELETE FROM outbox_events WHERE aggregate_id = $1`, [runId]);
      await pool.query(`DELETE FROM run_events WHERE run_id = $1`, [runId]);
      await pool.query(`DELETE FROM runs WHERE id = $1`, [runId]);
    }
    await pool.query(`DELETE FROM quotes WHERE organization_id = $1`, [organizationId]);
    await pool.query(`DELETE FROM releases WHERE id = $1`, [releaseId]);
    await pool.query(`DELETE FROM services WHERE id = $1`, [serviceId]);
    await pool.query(`DELETE FROM policies WHERE id = $1`, [policyId]);
    await pool.query(`DELETE FROM organizations WHERE id = $1`, [organizationId]);
    await pool.end();
  });

  it('enqueues a pending orchestrator job the moment a run becomes FUNDED', async () => {
    if (!pool) throw new Error('TEST_DATABASE_URL is required');
    const store = new PostgresPaymentReconciliationStore(pool);
    const run = await createPaymentRequiredRun(pool, 'orchestrator-trigger');

    await store.commitFundedRun(fundingInput(run, `0x${'a1'.repeat(32)}`, `0x${'a2'.repeat(32)}`, 0));

    await expect(
      pool.query<{ status: string }>(`SELECT status FROM orchestrator_jobs WHERE run_id = $1`, [run.run.id]),
    ).resolves.toMatchObject({ rows: [{ status: 'PENDING' }] });
  });

  it('rejects funding a second run with a payment proof hash already used by another run', async () => {
    if (!pool) throw new Error('TEST_DATABASE_URL is required');
    const store = new PostgresPaymentReconciliationStore(pool);
    const runA = await createPaymentRequiredRun(pool, 'proof-hash-a');
    const runB = await createPaymentRequiredRun(pool, 'proof-hash-b');

    const sharedProofHash = `0x${'ab'.repeat(32)}` as const;
    await store.commitFundedRun(fundingInput(runA, sharedProofHash, `0x${'11'.repeat(32)}`, 0));

    await expect(
      store.commitFundedRun(fundingInput(runB, sharedProofHash, `0x${'22'.repeat(32)}`, 0)),
    ).rejects.toThrow();

    await expect(
      pool.query<{ status: string }>(`SELECT status FROM runs WHERE id = $1`, [runB.run.id]),
    ).resolves.toMatchObject({ rows: [{ status: 'PAYMENT_REQUIRED' }] });
  });

  it('rejects funding a second run that replays the exact same on-chain transfer log as another run', async () => {
    if (!pool) throw new Error('TEST_DATABASE_URL is required');
    const store = new PostgresPaymentReconciliationStore(pool);
    const runC = await createPaymentRequiredRun(pool, 'proof-hash-c');
    const runD = await createPaymentRequiredRun(pool, 'proof-hash-d');

    const sharedTransactionHash = `0x${'33'.repeat(32)}` as const;
    await store.commitFundedRun(
      fundingInput(runC, `0x${'cc'.repeat(32)}`, sharedTransactionHash, 0),
    );

    await expect(
      store.commitFundedRun(fundingInput(runD, `0x${'dd'.repeat(32)}`, sharedTransactionHash, 0)),
    ).rejects.toThrow();

    await expect(
      pool.query<{ status: string }>(`SELECT status FROM runs WHERE id = $1`, [runD.run.id]),
    ).resolves.toMatchObject({ rows: [{ status: 'PAYMENT_REQUIRED' }] });
  });

  it('rejects a second funding attempt on the same run once it is already funded', async () => {
    if (!pool) throw new Error('TEST_DATABASE_URL is required');
    const store = new PostgresPaymentReconciliationStore(pool);
    const runE = await createPaymentRequiredRun(pool, 'proof-hash-e');

    await store.commitFundedRun(fundingInput(runE, `0x${'ee'.repeat(32)}`, `0x${'44'.repeat(32)}`, 0));

    await expect(
      store.commitFundedRun(fundingInput(runE, `0x${'ff'.repeat(32)}`, `0x${'55'.repeat(32)}`, 0)),
    ).rejects.toThrow('payment_receipts_customer_run_unique');

    await expect(
      pool.query<{ status: string }>(`SELECT status FROM runs WHERE id = $1`, [runE.run.id]),
    ).resolves.toMatchObject({ rows: [{ status: 'FUNDED' }] });
  });
});

type PaymentRequiredFixture = Readonly<{
  run: RunAggregate;
  order: MerchantOrder;
}>;

async function createPaymentRequiredRun(pool: Pool, label: string): Promise<PaymentRequiredFixture> {
  const runId = `run_${label}_${fixtureSuffix}`;
  runIds.push(runId);
  const now = new Date();

  const capability = {
    environment: 'mainnet' as const,
    merchantId: 'duplicate-charge-merchant',
    mode: 'ERC20_DIRECT' as const,
    chainId: 2345,
    tokenAddress: '0x1000000000000000000000000000000000000001' as const,
    tokenSymbol: 'DUPLICATE_ONLY',
    tokenDecimals: 6,
    receivingAddress: '0x3000000000000000000000000000000000000003' as const,
    minimumAtomicAmount: '1',
    maximumAtomicAmount: '100000000',
    discoveredAt: now.toISOString(),
    source: 'PORTAL_REVIEW' as const,
  };

  const quote = new QuoteEngine({
    pricingStatus: 'HYPOTHESIS',
    feeRateBps: 1667, // chosen so total stays 600, matching this file's on-chain fixture amounts
    mandatoryToolBudgetAtomic: '100',
    dynamicToolBudgetAtomic: '100',
    modelInfrastructureReserveAtomic: '100',
    chainStorageReserveAtomic: '100',
    riskSupportReserveAtomic: '100',
    quoteTtlSeconds: 900,
  }, () => `${label}-${fixtureSuffix}`).createQuote({
    organizationId,
    requesterAddress: '0x2000000000000000000000000000000000000002',
    targetAgentId: 'agent:external',
    targetServiceId,
    targetVersionHash: digest(`release:${fixtureSuffix}`),
    policyHash: digest(`policy:${fixtureSuffix}`),
    x402Endpoint,
    openApiUrl,
    maximumCustomerBudgetAtomic: '1000',
  }, capability, now);

  const quoteRepository = new PostgresQuoteRepository(pool);
  await quoteRepository.save(quote);

  const draft = createDraftRun(runId, now.toISOString());
  const quoted = transitionRun(draft, {
    actor: 'QUOTE_ENGINE',
    expectedRevision: 0,
    idempotencyKey: `quoted:${label}:${fixtureSuffix}`,
    occurredAt: now.toISOString(),
    to: 'QUOTED',
  });
  if (!quoted.event) throw new Error('Expected QUOTED domain event');
  const runRepository = new PostgresRunRepository(pool);
  await runRepository.save({
    aggregate: quoted.run,
    quoteId: quote.id,
    requestIdempotencyKey: `request:${label}:${fixtureSuffix}`,
    uncommittedEvent: quoted.event,
  });

  const paymentRequired = transitionRun(quoted.run, {
    actor: 'MERCHANT_GATEWAY',
    expectedRevision: quoted.run.revision,
    idempotencyKey: `payment-required:${label}:${fixtureSuffix}`,
    occurredAt: new Date(now.getTime() + 1_000).toISOString(),
    to: 'PAYMENT_REQUIRED',
  });
  if (!paymentRequired.event) throw new Error('Expected PAYMENT_REQUIRED domain event');
  await runRepository.save({
    aggregate: paymentRequired.run,
    quoteId: quote.id,
    requestIdempotencyKey: `request:${label}:${fixtureSuffix}`,
    uncommittedEvent: paymentRequired.event,
  }, quoted.run.revision);

  const order: MerchantOrder = {
    orderId: `order_${label}_${fixtureSuffix}`,
    dappOrderId: runId,
    status: 'PAYMENT_CONFIRMED',
    chainId: capability.chainId,
    tokenAddress: capability.tokenAddress,
    atomicAmount: quote.totalAtomicAmount,
    payerAddress: '0x2000000000000000000000000000000000000002',
    payToAddress: capability.receivingAddress,
    expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    paymentRequired: {
      x402Version: 1,
      resource: { url: x402Endpoint },
      accepts: [{
        scheme: 'exact',
        network: `eip155:${capability.chainId}`,
        amount: quote.totalAtomicAmount,
        asset: capability.tokenAddress,
        payTo: capability.receivingAddress,
        maxTimeoutSeconds: 300,
      }],
    },
  };
  const orderContextStore = new PostgresFlowOrderContextStore(pool);
  await orderContextStore.put({ order, capability });

  return { run: paymentRequired.run, order };
}

function fundingInput(
  fixture: PaymentRequiredFixture,
  proofHash: `0x${string}`,
  transactionHash: `0x${string}`,
  logIndex: number,
): Parameters<PostgresPaymentReconciliationStore['commitFundedRun']>[0] {
  const verifiedAt = new Date(Date.parse(fixture.run.updatedAt) + 1_000).toISOString();
  const funded = transitionRun(fixture.run, {
    actor: 'PAYMENT_RECONCILER',
    expectedRevision: fixture.run.revision,
    idempotencyKey: `customer-payment:${transactionHash.toLowerCase()}:${logIndex}`,
    occurredAt: verifiedAt,
    to: 'FUNDED',
  });
  if (!funded.event) throw new Error('Expected FUNDED domain event');

  const proof: MerchantPaymentProof = {
    orderId: fixture.order.orderId,
    transactionHash,
    logIndex,
    fromAddress: fixture.order.payerAddress,
    toAddress: fixture.order.payToAddress,
    atomicAmount: fixture.order.atomicAmount,
    chainId: fixture.order.chainId,
  };
  const receipt: NormalizedTransactionReceipt = {
    chainId: fixture.order.chainId,
    transactionHash,
    status: 1,
    logs: [{
      address: fixture.order.tokenAddress,
      topics: [`0x${'ff'.repeat(32)}`],
      data: '0x',
      index: logIndex,
    }],
  };

  return {
    previousRevision: fixture.run.revision,
    run: funded.run,
    event: funded.event,
    payment: {
      runId: fixture.run.id,
      order: fixture.order,
      proof,
      receipt,
      proofHash,
      verifiedAt,
    },
  };
}

function digest(value: string): `0x${string}` {
  return `0x${createHash('sha256').update(value).digest('hex')}`;
}

function hexBuffer(value: string): Buffer {
  return Buffer.from(value.slice(2), 'hex');
}
