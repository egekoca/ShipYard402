import { ShipyardApiClient, type MarketplaceService } from '@shipyard402/public-api-client';

/**
 * One dashboard can browse more than one Shipyard API deployment. Each deployment still owns its
 * own database, merchant adapter, workers and session signing key; this small routing layer keeps
 * a service tied to the backend that listed it instead of accidentally sending a BOT Chain quote
 * to the GOAT API.
 */
export type ApiBackendId = 'goat' | 'bot-chain';

export type RoutedMarketplaceService = MarketplaceService & Readonly<{ apiBackend: ApiBackendId }>;

export const DEFAULT_API_BACKEND: ApiBackendId = 'goat';

/**
 * What this build was actually told about, which is not necessarily every backend that exists.
 * A variable that is present but blank counts as absent: an unset value and one set to the empty
 * string mean the same thing to whoever configured the deployment, and treating them differently
 * is how a build ends up requesting an empty URL instead of falling back.
 */
function configuredUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

const CONFIGURED_URLS: Readonly<Record<ApiBackendId, string | undefined>> = {
  goat: configuredUrl(process.env['NEXT_PUBLIC_SHIPYARD_API_URL']),
  'bot-chain': configuredUrl(process.env['NEXT_PUBLIC_BOTCHAIN_API_URL']),
};

/** Where each backend runs in a plain local checkout, so `pnpm dev` needs no configuration. */
const LOOPBACK_URLS: Readonly<Record<ApiBackendId, string>> = {
  goat: 'http://127.0.0.1:3001',
  'bot-chain': 'http://127.0.0.1:3011',
};

const CONFIGURED_BACKENDS = (Object.keys(CONFIGURED_URLS) as ApiBackendId[]).filter((id) => CONFIGURED_URLS[id]);

export function apiBaseUrl(backend: ApiBackendId): string {
  return CONFIGURED_URLS[backend] ?? LOOPBACK_URLS[backend];
}

export function createApiClient(backend: ApiBackendId, getSessionToken?: () => string | null): ShipyardApiClient {
  return new ShipyardApiClient(apiBaseUrl(backend), undefined, getSessionToken);
}

export function backendForChainId(chainId: number): ApiBackendId {
  return chainId === 968 ? 'bot-chain' : 'goat';
}

export function fundingChainIdForBackend(backend: ApiBackendId): number {
  return backend === 'bot-chain' ? 968 : Number(process.env['NEXT_PUBLIC_DEFAULT_CHAIN_ID'] ?? 48816);
}

export function parseApiBackend(value: string | undefined): ApiBackendId {
  return value === 'bot-chain' ? 'bot-chain' : DEFAULT_API_BACKEND;
}

/**
 * The backends this build may browse. A deployment that was never told where a backend lives must
 * not fall back to loopback and query it anyway: from an HTTPS page that request is a mixed-content
 * error in every visitor's console, aimed at their own machine, and the tab it feeds can never be
 * anything but empty. So a configured build browses exactly what it was configured with.
 *
 * With nothing configured at all -- a bare local checkout running `pnpm dev` -- both loopback
 * backends stay in, which is where they actually are.
 */
export const MARKETPLACE_BACKENDS: readonly ApiBackendId[] =
  CONFIGURED_BACKENDS.length > 0 ? CONFIGURED_BACKENDS : (['goat', 'bot-chain'] as const);
