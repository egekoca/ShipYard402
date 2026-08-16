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

const BACKEND_URLS: Readonly<Record<ApiBackendId, string>> = {
  goat: process.env['NEXT_PUBLIC_SHIPYARD_API_URL'] ?? 'http://127.0.0.1:3001',
  'bot-chain': process.env['NEXT_PUBLIC_BOTCHAIN_API_URL'] ?? 'http://127.0.0.1:3011',
};

export function apiBaseUrl(backend: ApiBackendId): string {
  return BACKEND_URLS[backend];
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

export const MARKETPLACE_BACKENDS: readonly ApiBackendId[] = ['goat', 'bot-chain'];
