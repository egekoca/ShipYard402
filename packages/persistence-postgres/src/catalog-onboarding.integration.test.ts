import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import { listMarketplaceServices } from './catalog-listing.js';
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

  it('publishes only the services that opted in, with everything a quote needs to bind', async () => {
    if (!pool) throw new Error('TEST_DATABASE_URL is required');
    const suffix = randomUUID();
    const listedId = `service:listed:${suffix}`;
    const privateId = `service:private:${suffix}`;

    const listed = await onboardService(pool, {
      organizationName: `Directory listing ${suffix}`,
      requesterAddress,
      externalServiceId: listedId,
      serviceName: 'Listed API',
      x402Endpoint: 'https://api.example.com/paid/listed',
      openApiUrl: OPENAPI_URL,
      version: '3.2.1',
      marketplaceListed: true,
      description: 'A paid API that agreed to be discoverable.',
    });
    await onboardService(pool, {
      organizationName: `Directory listing ${suffix}`,
      requesterAddress,
      externalServiceId: privateId,
      serviceName: 'Private API',
      x402Endpoint: 'https://api.example.com/paid/private',
      openApiUrl: OPENAPI_URL,
      version: '1.0.0',
    });

    const services = await listMarketplaceServices(pool, 200);
    const ids = services.map((service) => service.targetServiceId);
    expect(ids).toContain(listedId);
    // Opting out is the default, and the directory has to honour it -- a private registration
    // leaking a customer's paid endpoint to every visitor is the failure this guards against.
    expect(ids).not.toContain(privateId);

    // A listing is only useful if it can be quoted straight from the card, so the identifiers it
    // carries must be the same ones onboarding produced -- not a lossy rendering of them.
    expect(services.find((service) => service.targetServiceId === listedId)).toMatchObject({
      organizationId: listed.organizationId,
      targetAgentId: listed.targetAgentId,
      targetVersionHash: listed.targetVersionHash,
      policyHash: listed.policyHash,
      x402Endpoint: listed.x402Endpoint,
      openApiUrl: listed.openApiUrl,
      name: 'Listed API',
      description: 'A paid API that agreed to be discoverable.',
      version: '3.2.1',
    });
  }, 30_000);

  it('lets a re-onboarding call pull its own service back out of the directory', async () => {
    if (!pool) throw new Error('TEST_DATABASE_URL is required');
    const suffix = randomUUID();
    const externalServiceId = `service:delisted:${suffix}`;
    const base = {
      organizationName: `Delisting ${suffix}`,
      requesterAddress,
      externalServiceId,
      serviceName: 'Delisted API',
      x402Endpoint: 'https://api.example.com/paid/delisted',
      openApiUrl: OPENAPI_URL,
      version: '1.0.0',
    };

    await onboardService(pool, { ...base, marketplaceListed: true });
    expect((await listMarketplaceServices(pool, 200)).map((s) => s.targetServiceId)).toContain(externalServiceId);

    await onboardService(pool, { ...base, marketplaceListed: false });
    expect((await listMarketplaceServices(pool, 200)).map((s) => s.targetServiceId)).not.toContain(externalServiceId);
  }, 30_000);
});

function hexBuffer(value: string): Buffer {
  return Buffer.from(value.slice(2), 'hex');
}
