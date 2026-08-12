import { createHash } from 'node:crypto';

import { createEgressSafeFetch, EgressForbiddenError } from '@shipyard402/policy-engine';
import type { Pool } from 'pg';

/**
 * The one thing this whole pipeline actually enforces today (apps/orchestrator-worker reads
 * ORCHESTRATOR_MANDATORY_SCENARIOS from its own runtime config, not from a policy row's content),
 * so every onboarded service shares this single real, well-known policy rather than pretending
 * onboarding can configure a mandatory-scenario set the runtime doesn't actually read yet.
 * Fixed, canonical content means a fixed, canonical policy_hash: get-or-create is idempotent
 * without needing a lookup table.
 */
const STANDARD_POLICY = {
  name: 'shipyard402-standard',
  version: '1',
  mandatoryScenarios: ['payment-proof-replay'],
  mandateTemplate: {
    description:
      'AI proposes additional scenarios and a budget; a deterministic compiler always ' +
      'keeps the mandatory scenario and clamps the budget to the quote ceiling (see ADR-0006).',
  },
} as const;

export class OnboardingFetchError extends Error {
  readonly code: 'OPENAPI_FETCH_FAILED' | 'OPENAPI_NOT_JSON' | 'OPENAPI_HOST_FORBIDDEN';

  constructor(code: 'OPENAPI_FETCH_FAILED' | 'OPENAPI_NOT_JSON' | 'OPENAPI_HOST_FORBIDDEN', message: string) {
    super(message);
    this.name = 'OnboardingFetchError';
    this.code = code;
  }
}

export type OnboardServiceInput = Readonly<{
  organizationName: string;
  requesterAddress: `0x${string}`;
  externalServiceId: string;
  serviceName: string;
  x402Endpoint: string;
  openApiUrl: string;
  version: string;
  /**
   * Opt-in public discovery. Left off, a service is quotable only by whoever already knows its
   * catalog identifiers -- which is the right default, since onboarding an endpoint to test it is
   * not consent to publish that endpoint to everyone browsing the marketplace.
   */
  marketplaceListed?: boolean;
  description?: string;
  /** The chain this service settles on; the marketplace filters the directory by it. Defaults to
   * GOAT Testnet3 (48816) -- the one chain onboarding targeted before cross-chain listings. */
  chainId?: number;
}>;

export type OnboardServiceResult = Readonly<{
  organizationId: string;
  targetServiceId: string;
  /**
   * Returned rather than left to the caller: this string is hashed into the on-chain attestation
   * as the target's identity, and a frontend that just kept whatever was in the form would attest
   * a freshly onboarded service under the self-test target's agent id.
   */
  targetAgentId: string;
  targetVersionHash: `0x${string}`;
  policyHash: `0x${string}`;
  x402Endpoint: string;
  openApiUrl: string;
}>;

const egressSafeFetch = createEgressSafeFetch();

/**
 * Fetches the caller's own OpenAPI document (through the same SSRF-hardened fetch the
 * orchestrator uses for outbound calls, since this endpoint takes an arbitrary URL from an
 * unauthenticated caller) and hashes its canonical bytes -- that hash becomes the release's
 * version_hash, so "this exact version" means what it says instead of a hand-typed placeholder.
 */
async function fetchAndHashOpenApiDocument(openApiUrl: string): Promise<{ canonicalJson: string; hash: Buffer }> {
  let response: Response;
  try {
    response = await egressSafeFetch(openApiUrl, { redirect: 'manual' });
  } catch (error) {
    if (error instanceof EgressForbiddenError) {
      throw new OnboardingFetchError('OPENAPI_HOST_FORBIDDEN', error.message);
    }
    throw new OnboardingFetchError('OPENAPI_FETCH_FAILED', 'Could not reach the OpenAPI document URL.');
  }
  if (!response.ok) {
    throw new OnboardingFetchError('OPENAPI_FETCH_FAILED', `OpenAPI document fetch returned HTTP ${response.status}.`);
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new OnboardingFetchError('OPENAPI_NOT_JSON', 'The OpenAPI document URL did not return valid JSON.');
  }
  const canonicalJson = canonicalize(parsed);
  return { canonicalJson, hash: createHash('sha256').update(canonicalJson).digest() };
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(',')}}`;
}

function policyHash(): Buffer {
  return createHash('sha256').update(canonicalize(STANDARD_POLICY)).digest();
}

export async function onboardService(pool: Pool, input: OnboardServiceInput): Promise<OnboardServiceResult> {
  const { hash: versionHash } = await fetchAndHashOpenApiDocument(input.openApiUrl);
  const standardPolicyHash = policyHash();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO policies (policy_hash, name, version, mandatory_scenarios, mandate_template)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
       ON CONFLICT (policy_hash) DO NOTHING`,
      [
        standardPolicyHash,
        STANDARD_POLICY.name,
        STANDARD_POLICY.version,
        JSON.stringify(STANDARD_POLICY.mandatoryScenarios),
        JSON.stringify(STANDARD_POLICY.mandateTemplate),
      ],
    );

    // One organization per requester wallet: repeat onboarding from the same address reuses it
    // rather than accumulating a fresh, empty organization on every call. This must be one atomic
    // upsert, not a SELECT followed by an INSERT -- two concurrent onboarding calls for the same
    // wallet (an ordinary client retry, or two near-simultaneous requests) would otherwise both
    // see no existing row and both insert, creating two organizations for one wallet.
    const requesterBuffer = hexToBuffer(input.requesterAddress);
    const organizationId = (
      await client.query<{ id: string }>(
        `INSERT INTO organizations (name, billing_wallet) VALUES ($1, $2)
         ON CONFLICT (billing_wallet) DO UPDATE SET name = organizations.name
         RETURNING id`,
        [input.organizationName, requesterBuffer],
      )
    ).rows[0]!.id;

    // marketplace_listed and description are re-onboarding-controlled on purpose: the same wallet
    // calling again is how a service gets listed after the fact, or pulled back out of the
    // marketplace, without needing a second endpoint for it.
    const service = await client.query<{ id: string }>(
      `INSERT INTO services (
         organization_id, external_service_id, name, x402_endpoint, openapi_url,
         marketplace_listed, description, target_agent_id, marketplace_policy_hash, chain_id
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (organization_id, external_service_id)
       DO UPDATE SET name = EXCLUDED.name,
                     x402_endpoint = EXCLUDED.x402_endpoint,
                     openapi_url = EXCLUDED.openapi_url,
                     marketplace_listed = EXCLUDED.marketplace_listed,
                     description = EXCLUDED.description,
                     chain_id = EXCLUDED.chain_id
       RETURNING id`,
      [
        organizationId,
        input.externalServiceId,
        input.serviceName,
        input.x402Endpoint,
        input.openApiUrl,
        input.marketplaceListed ?? false,
        input.description ?? null,
        `agent:${input.externalServiceId}`,
        // The policy this service is offered under in the directory -- the same one the returned
        // OnboardServiceResult tells the caller to quote with, so a listing can never advertise a
        // policy the owner's own quote flow doesn't use.
        standardPolicyHash,
        // The chain this service settles on; defaults to GOAT Testnet3.
        input.chainId ?? 48816,
      ],
    );
    const serviceId = service.rows[0]!.id;

    await client.query(
      `INSERT INTO releases (service_id, version, version_hash, manifest_hash)
       VALUES ($1, $2, $3, $3)
       ON CONFLICT (service_id, version_hash) DO NOTHING`,
      [serviceId, input.version, versionHash],
    );

    await client.query('COMMIT');
    return {
      organizationId,
      targetServiceId: input.externalServiceId,
      targetAgentId: `agent:${input.externalServiceId}`,
      targetVersionHash: bufferToHex(versionHash),
      policyHash: bufferToHex(standardPolicyHash),
      x402Endpoint: input.x402Endpoint,
      openApiUrl: input.openApiUrl,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function hexToBuffer(value: string): Buffer {
  return Buffer.from(value.slice(2), 'hex');
}

function bufferToHex(value: Buffer): `0x${string}` {
  return `0x${value.toString('hex')}`;
}
