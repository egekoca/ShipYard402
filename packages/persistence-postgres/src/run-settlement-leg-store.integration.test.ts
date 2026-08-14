import { createHash, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createShipyardPool } from './pool.js';
import { PostgresRunSettlementLegStore, type RunSettlementLeg } from './run-settlement-leg-store.js';

const databaseUrl = process.env['TEST_DATABASE_URL'];
const suffix = randomUUID();
const organizationId = randomUUID();
const serviceId = randomUUID();
const releaseId = randomUUID();
const policyId = randomUUID();
const quoteId = `quote_legs_${suffix}`;
const runId = `run_legs_${suffix}`;

const pool = databaseUrl ? createShipyardPool({ connectionString: databaseUrl, useTls: false }) : null;

/** Deterministic synthetic fixtures, so a rerun cannot collide with a previous one. */
const bytes32 = (seed: string): Buffer => createHash('sha256').update(seed).digest();
const address = (seed: string): Buffer => bytes32(seed).subarray(0, 20);

function leg(overrides: Partial<RunSettlementLeg> = {}): RunSettlementLeg {
  return {
    runId,
    legIndex: 0,
    kind: 'BRIDGE',
    network: 'eip155:2345',
    assetSymbol: 'USDT',
    assetDecimals: 6,
    status: 'SUBMITTED',
    transactionHash: `0x${'11'.repeat(32)}`,
    amountAtomic: '250000',
    provider: 'STARGATE_V2_LAYERZERO',
    ...overrides,
  };
}

describe.skipIf(!databaseUrl)('PostgreSQL run settlement legs', () => {
  beforeAll(async () => {
    if (!pool) throw new Error('TEST_DATABASE_URL is required');
    await pool.query(`INSERT INTO organizations (id, name, billing_wallet) VALUES ($1, $2, $3)`, [
      organizationId,
      `Legs ${suffix}`,
      // billing_wallet is a 20-byte address and unique per organization.
      address(`org-wallet:${suffix}`),
    ]);
    await pool.query(
      `INSERT INTO services (id, organization_id, external_service_id, name, x402_endpoint, openapi_url)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        serviceId,
        organizationId,
        `service:legs:${suffix}`,
        `legs-${suffix}`,
        `https://target.example/${suffix}/paid`,
        `https://target.example/${suffix}/openapi.json`,
      ],
    );
    await pool.query(
      `INSERT INTO releases (id, service_id, version, version_hash, manifest_hash) VALUES ($1, $2, $3, $4, $5)`,
      [releaseId, serviceId, 'integration', bytes32(`release:${suffix}`), bytes32(`manifest:${suffix}`)],
    );
    await pool.query(
      `INSERT INTO policies (id, name, version, policy_hash, mandatory_scenarios, mandate_template)
       VALUES ($1, $2, 'integration', $3, '[]'::jsonb, '{}'::jsonb)`,
      [policyId, `legs-${suffix}`, bytes32(`policy:${suffix}`)],
    );
    await pool.query(
      `INSERT INTO quotes (id, organization_id, service_id, release_id, policy_id, requester,
                           request_snapshot, capability_snapshot, line_items, payment_chain_id, payment_token,
                           total_atomic_amount, refundable_tool_budget_atomic, pricing_status, quote_commitment,
                           created_at, expires_at, target_chain_id)
       VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, 48816, $7, 600, 300,
               'HYPOTHESIS', $8, now(), now() + interval '1 hour', 48816)`,
      [
        quoteId,
        organizationId,
        serviceId,
        releaseId,
        policyId,
        address(`requester:${suffix}`),
        address(`token:${suffix}`),
        bytes32(`commitment:${suffix}`),
      ],
    );
    await pool.query(
      `INSERT INTO runs (id, quote_id, service_id, release_id, policy_id, requester, status, revision,
                         actual_tool_spend_atomic, request_idempotency_key, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'PROCURING', 1, 0, $7, now(), now())`,
      [runId, quoteId, serviceId, releaseId, policyId, address(`requester:${suffix}`), `legs-${suffix}`],
    );
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DELETE FROM run_settlement_legs WHERE run_id = $1`, [runId]);
    await pool.query(`DELETE FROM runs WHERE id = $1`, [runId]);
    await pool.query(`DELETE FROM quotes WHERE id = $1`, [quoteId]);
    await pool.query(`DELETE FROM policies WHERE id = $1`, [policyId]);
    await pool.query(`DELETE FROM releases WHERE id = $1`, [releaseId]);
    await pool.query(`DELETE FROM services WHERE id = $1`, [serviceId]);
    await pool.query(`DELETE FROM organizations WHERE id = $1`, [organizationId]);
    await pool.end();
  });

  it('records legs and returns them in execution order', async () => {
    if (!pool) throw new Error('TEST_DATABASE_URL is required');
    const store = new PostgresRunSettlementLegStore(pool);

    await store.record(leg({ legIndex: 1, kind: 'TARGET_PAYMENT', network: 'eip155:56', status: 'PENDING' }));
    await store.record(leg({ legIndex: 0 }));

    const legs = await store.listByRunId(runId);
    expect(legs.map((entry) => entry.legIndex)).toEqual([0, 1]);
    expect(legs[0]).toMatchObject({ kind: 'BRIDGE', assetSymbol: 'USDT', amountAtomic: '250000' });
  });

  it('advances a leg in place rather than duplicating it, keeping what it already knew', async () => {
    // A re-claimed job repeats its phase; the leg must move forward, not appear twice, and must not
    // lose the transaction hash simply because the later write did not repeat it.
    if (!pool) throw new Error('TEST_DATABASE_URL is required');
    const store = new PostgresRunSettlementLegStore(pool);
    await store.record(leg({ legIndex: 0, status: 'SUBMITTED' }));

    await store.record({
      runId,
      legIndex: 0,
      kind: 'BRIDGE',
      network: 'eip155:2345',
      assetSymbol: 'USDT',
      assetDecimals: 6,
      status: 'CONFIRMED',
      amountAtomic: '249000',
    });

    const legs = await store.listByRunId(runId);
    const bridge = legs.filter((entry) => entry.legIndex === 0);
    expect(bridge).toHaveLength(1);
    expect(bridge[0]).toMatchObject({
      status: 'CONFIRMED',
      amountAtomic: '249000',
      transactionHash: `0x${'11'.repeat(32)}`,
      provider: 'STARGATE_V2_LAYERZERO',
    });
  });

  it('refuses to walk a confirmed leg backwards', async () => {
    // Out-of-order writes are possible under retries; a finished step must not start spinning again.
    if (!pool) throw new Error('TEST_DATABASE_URL is required');
    const store = new PostgresRunSettlementLegStore(pool);
    await store.record(leg({ legIndex: 0, status: 'CONFIRMED', amountAtomic: '249000' }));

    await store.record(leg({ legIndex: 0, status: 'SUBMITTED' }));

    const legs = await store.listByRunId(runId);
    expect(legs.find((entry) => entry.legIndex === 0)?.status).toBe('CONFIRMED');
  });

  it('rejects a confirmed leg that cannot say how much moved', async () => {
    if (!pool) throw new Error('TEST_DATABASE_URL is required');
    const store = new PostgresRunSettlementLegStore(pool);

    await expect(
      store.record({
        runId,
        legIndex: 7,
        kind: 'TARGET_PAYMENT',
        network: 'eip155:56',
        assetSymbol: 'USD1',
        assetDecimals: 18,
        status: 'CONFIRMED',
      }),
    ).rejects.toThrow();
  });
});
