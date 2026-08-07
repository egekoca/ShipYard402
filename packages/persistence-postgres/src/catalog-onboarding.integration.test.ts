import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import { onboardService } from './catalog-onboarding.js';
import { createShipyardPool } from './pool.js';

const databaseUrl = process.env['TEST_DATABASE_URL'];
const pool = databaseUrl
  ? createShipyardPool({ connectionString: databaseUrl, useTls: false, maximumConnections: 4 })
  : null;

// A real, small, publicly reachable OpenAPI document -- fetchAndHashOpenApiDocument goes through
// the SSRF-hardened egress fetch with no injection point for a fake transport, so this exercises
// the real network path rather than mocking around it, matching how this endpoint was verified
// end-to-end during development (curl and a live browser run against the same document).
const OPENAPI_URL = 'https://petstore3.swagger.io/api/v3/openapi.json';

describe.skipIf(!databaseUrl)('catalog onboarding integration', () => {
  const requesterAddress = `0x${randomUUID().replace(/-/g, '').slice(0, 40).padEnd(40, '0')}` as `0x${string}`;

  afterAll(async () => {
    if (!pool) return;
    await pool.query(
      `DELETE FROM releases WHERE service_id IN (
         SELECT id FROM services WHERE organization_id IN (
           SELECT id FROM organizations WHERE billing_wallet = $1
         )
       )`,
      [hexBuffer(requesterAddress)],
    );
    await pool.query(
      `DELETE FROM services WHERE organization_id IN (SELECT id FROM organizations WHERE billing_wallet = $1)`,
      [hexBuffer(requesterAddress)],
    );
    await pool.query(`DELETE FROM organizations WHERE billing_wallet = $1`, [hexBuffer(requesterAddress)]);
    // The standard policy row is shared, permanent fixture data (every onboarding call reuses the
    // same canonical policy hash) -- not scoped to this test, so it is deliberately left alone.
    await pool.end();
  });

  it('never creates two organizations for the same wallet under concurrent onboarding calls', async () => {
    if (!pool) throw new Error('TEST_DATABASE_URL is required');
    const suffix = randomUUID();

    const [first, second] = await Promise.all([
      onboardService(pool, {
        organizationName: `Concurrent onboarding ${suffix}`,
        requesterAddress,
        externalServiceId: `service:concurrent-a:${suffix}`,
        serviceName: 'Concurrent A',
        x402Endpoint: 'https://api.example.com/paid/a',
        openApiUrl: OPENAPI_URL,
        version: '1.0.0',
      }),
      onboardService(pool, {
        organizationName: `Concurrent onboarding ${suffix}`,
        requesterAddress,
        externalServiceId: `service:concurrent-b:${suffix}`,
        serviceName: 'Concurrent B',
        x402Endpoint: 'https://api.example.com/paid/b',
        openApiUrl: OPENAPI_URL,
        version: '1.0.0',
      }),
    ]);

    expect(first.organizationId).toBe(second.organizationId);

    const rows = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM organizations WHERE billing_wallet = $1`,
      [hexBuffer(requesterAddress)],
    );
    expect(rows.rows[0]?.count).toBe('1');
  }, 30_000);
});

function hexBuffer(value: string): Buffer {
  return Buffer.from(value.slice(2), 'hex');
}
