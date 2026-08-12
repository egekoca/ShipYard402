import type { Pool, QueryResultRow } from 'pg';

/**
 * Everything a browser needs to (a) render a marketplace card and (b) submit a quote request for
 * that service without the person having to hand-type a UUID and two 32-byte hashes. The second
 * half of that is not decorative: resolveCatalogBinding() in api-repositories.ts matches a quote
 * against organization_id + external_service_id + x402_endpoint + openapi_url + version_hash +
 * policy_hash, so a listing that omitted any of them would be un-quotable.
 */
export type MarketplaceServiceEntry = Readonly<{
  organizationId: string;
  targetServiceId: string;
  targetAgentId: string;
  targetVersionHash: `0x${string}`;
  policyHash: `0x${string}`;
  x402Endpoint: string;
  openApiUrl: string;
  name: string;
  description: string | null;
  logoUrl: string | null;
  version: string;
  /** The chain this service settles on -- the marketplace filters the directory by it. */
  chainId: number;
  listedAt: string;
}>;

type MarketplaceRow = QueryResultRow & {
  organization_id: string;
  external_service_id: string;
  target_agent_id: string | null;
  version_hash: Buffer;
  x402_endpoint: string;
  openapi_url: string;
  name: string;
  description: string | null;
  logo_url: string | null;
  version: string;
  policy_hash: Buffer;
  chain_id: string | number;
  created_at: Date | string;
};

/**
 * Lists the services that opted into public discovery, each pinned to its newest release. Newest
 * rather than "the release the owner last quoted" because a marketplace entry is an invitation to
 * test what is deployed now -- an older version_hash would quietly test a release nobody runs.
 *
 * Both joins are inner joins on purpose: a listing with no release, or one naming a policy that no
 * longer exists, cannot be quoted (resolveCatalogBinding in api-repositories.ts requires both), so
 * it is dropped here rather than rendered as a card that fails the moment it is clicked.
 */
export async function listMarketplaceServices(pool: Pool, limit = 60): Promise<readonly MarketplaceServiceEntry[]> {
  const result = await pool.query<MarketplaceRow>(
    `SELECT
       s.organization_id,
       s.external_service_id,
       s.target_agent_id,
       s.x402_endpoint,
       s.openapi_url,
       s.name,
       s.description,
       s.logo_url,
       r.version,
       r.version_hash,
       p.policy_hash,
       s.chain_id,
       s.created_at
     FROM services s
     JOIN LATERAL (
       SELECT version, version_hash
       FROM releases
       WHERE service_id = s.id
       ORDER BY created_at DESC, id DESC
       LIMIT 1
     ) r ON true
     JOIN policies p ON p.policy_hash = s.marketplace_policy_hash
     WHERE s.marketplace_listed = true
       AND s.active = true
     ORDER BY s.marketplace_rank ASC, s.created_at ASC
     LIMIT $1`,
    [limit],
  );

  return result.rows.map((row) => ({
    organizationId: row.organization_id,
    targetServiceId: row.external_service_id,
    targetAgentId: row.target_agent_id ?? `agent:${row.external_service_id}`,
    targetVersionHash: `0x${row.version_hash.toString('hex')}`,
    policyHash: `0x${row.policy_hash.toString('hex')}`,
    x402Endpoint: row.x402_endpoint,
    openApiUrl: row.openapi_url,
    name: row.name,
    description: row.description,
    logoUrl: row.logo_url,
    version: row.version,
    chainId: Number(row.chain_id),
    listedAt: new Date(row.created_at).toISOString(),
  }));
}
