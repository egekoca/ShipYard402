'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import {
  backendForChainId,
  createApiClient,
  MARKETPLACE_BACKENDS,
  type RoutedMarketplaceService,
} from '../lib/api-backends';
import { NetworkLogo } from './network-marks';

type MarketplaceState =
  | Readonly<{ kind: 'loading' }>
  | Readonly<{ kind: 'ready'; services: readonly RoutedMarketplaceService[] }>
  | Readonly<{ kind: 'unavailable' }>;

/** The chain filter tabs, and how a service's chainId maps onto one of them. */
type ChainFilter = 'goat' | 'bnb' | 'bot-chain';
const CHAIN_TABS: readonly Readonly<{ key: ChainFilter; label: string; logoId: string }>[] = [
  { key: 'goat', label: 'GOAT', logoId: 'goat-mainnet' },
  { key: 'bnb', label: 'BNB', logoId: 'bnb' },
  { key: 'bot-chain', label: 'BOT Chain', logoId: 'bot-chain' },
];

function chainFilterFor(chainId: number): ChainFilter {
  if (chainId === 56) return 'bnb';
  if (chainId === 968) return 'bot-chain';
  return 'goat'; // GOAT mainnet (2345) and Testnet3 (48816)
}

/**
 * The directory of x402 services anyone can point a run at, so choosing a target is picking a card
 * rather than hand-typing a UUID and two 32-byte hashes. Read-only and unauthenticated -- browsing
 * happens before a wallet is ever connected, and a listing already carries every identifier a
 * quote request needs, so selecting one fills the whole form in a single click.
 */
export function ServiceMarketplace({
  selectedServiceId,
  selectedApiBackend = 'goat',
  canRegister,
  onSelect,
  onRegisterOwn,
}: Readonly<{
  selectedServiceId: string;
  selectedApiBackend?: string;
  /** Registering writes a catalog row owned by a wallet, so it needs a connected one first. */
  canRegister: boolean;
  onSelect: (service: RoutedMarketplaceService) => void;
  onRegisterOwn: () => void;
}>) {
  const [state, setState] = useState<MarketplaceState>({ kind: 'loading' });
  const [chain, setChain] = useState<ChainFilter>('goat');
  // Held in a ref so adopting the first listing depends on the listing arriving, not on the parent
  // happening to hand us a new callback identity on some later render.
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    const controller = new AbortController();
    Promise.allSettled(
      MARKETPLACE_BACKENDS.map(async (apiBackend) => {
        const services = await createApiClient(apiBackend).listMarketplaceServices(controller.signal);
        // A backend is authoritative only for the chains it can actually execute. This also
        // prevents a stale/misconfigured duplicate row from being shown with the wrong router.
        return services
          .filter((service) => backendForChainId(service.chainId) === apiBackend)
          .map((service) => ({ ...service, apiBackend }));
      }),
    ).then((results) => {
      if (controller.signal.aborted) return;
      const services: RoutedMarketplaceService[] = [];
      let reachableBackendCount = 0;
      for (const result of results) {
        if (result.status !== 'fulfilled') continue;
        reachableBackendCount += 1;
        services.push(...result.value);
      }
      if (reachableBackendCount === 0) {
        setState({ kind: 'unavailable' });
        return;
      }
      setState({ kind: 'ready', services });
    });
    return () => controller.abort();
  }, []);

  const services = state.kind === 'ready' ? state.services : [];
  const countByChain = useMemo(() => {
    const counts: Record<ChainFilter, number> = { goat: 0, bnb: 0, 'bot-chain': 0 };
    for (const service of services) counts[chainFilterFor(service.chainId)] += 1;
    return counts;
  }, [services]);
  const visibleServices = services.filter((service) => chainFilterFor(service.chainId) === chain);

  // Land the user on a chain that actually has listings so the directory never opens empty when
  // something is listed elsewhere. Runs once services arrive; a manual toggle afterward sticks.
  const hasServices = services.length > 0;
  useEffect(() => {
    if (!hasServices) return;
    setChain((current) =>
      countByChain[current] > 0 ? current : (CHAIN_TABS.find((t) => countByChain[t.key] > 0)?.key ?? current),
    );
  }, [hasServices, countByChain]);

  // The form holds no target until something real supplies one, so adopt the first listing as soon
  // as the directory has one. Without this a first-time visitor lands on a form that cannot be
  // submitted at all; with it they land on a target whose every identifier came from the catalog.
  // Guarded on the parent still having no selection, so a later manual pick is never overridden.
  const firstService = services[0];
  useEffect(() => {
    if (!firstService || selectedServiceId) return;
    onSelectRef.current(firstService);
  }, [firstService, selectedServiceId]);

  return (
    <section className="marketplace" aria-label="x402 service directory">
      <header className="marketplace-header">
        <div>
          <span className="panel-label">TARGET DIRECTORY</span>
          <p className="marketplace-intro">
            Pick a live x402 service to test. Every listing is a real paid endpoint — the run pays it for real before
            attacking its payment logic.
          </p>
        </div>
        <button type="button" className="link-toggle" onClick={onRegisterOwn} disabled={!canRegister}>
          {canRegister ? 'Not listed? Add your API →' : 'Connect a wallet to add your API'}
        </button>
      </header>

      {state.kind === 'ready' && (
        <div className="chain-filter" role="tablist" aria-label="Filter targets by chain">
          {CHAIN_TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={chain === tab.key}
              className={chain === tab.key ? 'chain-tab chain-tab--active' : 'chain-tab'}
              onClick={() => setChain(tab.key)}
            >
              <NetworkLogo networkId={tab.logoId} size={16} className="chain-tab-logo" />
              {tab.label}
              <span className="chain-tab-count">{countByChain[tab.key]}</span>
            </button>
          ))}
        </div>
      )}

      {state.kind === 'loading' && (
        <div className="marketplace-grid" aria-busy="true">
          {[0, 1, 2].map((slot) => (
            <div className="marketplace-card marketplace-card--skeleton" key={slot} aria-hidden="true" />
          ))}
        </div>
      )}

      {state.kind === 'unavailable' && (
        <p className="marketplace-empty">
          The directory is unreachable right now. You can still register and test your own service below.
        </p>
      )}

      {state.kind === 'ready' && services.length === 0 && (
        <p className="marketplace-empty">
          No services have been listed publicly yet. Register yours below and tick “list it publicly” to be the first.
        </p>
      )}

      {state.kind === 'ready' && services.length > 0 && visibleServices.length === 0 && (
        <p className="marketplace-empty">
          No {CHAIN_TABS.find((t) => t.key === chain)?.label} targets listed yet — register one below, or pick another
          chain above.
        </p>
      )}

      {state.kind === 'ready' && visibleServices.length > 0 && (
        <ul className="marketplace-grid">
          {visibleServices.map((service) => (
            <li key={`${service.apiBackend}:${service.organizationId}:${service.targetServiceId}`}>
              <ServiceCard
                service={service}
                selected={service.targetServiceId === selectedServiceId && service.apiBackend === selectedApiBackend}
                onSelect={() => onSelect(service)}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ServiceCard({
  service,
  selected,
  onSelect,
}: Readonly<{ service: RoutedMarketplaceService; selected: boolean; onSelect: () => void }>) {
  // A listing's logo is set by operators, not by the onboarding API, so it is a known-good local
  // asset rather than an arbitrary remote URL -- but a stale path shouldn't leave a broken image
  // in the card, so a failure falls back to the same monogram every un-logoed service gets.
  const [logoFailed, setLogoFailed] = useState(false);
  const showLogo = Boolean(service.logoUrl) && !logoFailed;

  return (
    <button
      type="button"
      className={selected ? 'marketplace-card marketplace-card--selected' : 'marketplace-card'}
      onClick={onSelect}
      aria-pressed={selected}
    >
      <div className="marketplace-card-head">
        {showLogo ? (
          // biome-ignore lint/performance/noImgElement: static 34px listing asset, and next/image would swallow the onError fallback below
          <img className="marketplace-logo" src={service.logoUrl ?? ''} alt="" onError={() => setLogoFailed(true)} />
        ) : (
          <span className="marketplace-logo marketplace-logo--monogram" aria-hidden="true">
            {monogram(service.name)}
          </span>
        )}
        <div className="marketplace-card-title">
          <strong>{service.name}</strong>
          {/* No "v" prefix: a release version is a free-form string here, not necessarily semver
              (the demo target's is "testnet3-real-merchant"), and prefixing turns it to nonsense. */}
          <span className="marketplace-version mono">{service.version}</span>
        </div>
        {selected && <span className="marketplace-selected-badge">SELECTED</span>}
      </div>

      {service.description && <p className="marketplace-description">{service.description}</p>}

      <dl className="marketplace-meta">
        <div>
          <dt>Paid endpoint</dt>
          <dd className="mono">{shortenUrl(service.x402Endpoint)}</dd>
        </div>
        <div>
          <dt>Version hash</dt>
          <dd className="mono">{`${service.targetVersionHash.slice(0, 10)}…${service.targetVersionHash.slice(-6)}`}</dd>
        </div>
      </dl>

      <span className="marketplace-cta">{selected ? 'Selected as target' : 'Test this API →'}</span>
    </button>
  );
}

/** Up to two initials from the service name, so an un-logoed listing still reads as a distinct tile. */
export function monogram(name: string): string {
  const words = name
    .split(/[\s:_/-]+/)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((word) => word.length > 0);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return `${words[0]![0]!}${words[1]![0]!}`.toUpperCase();
}

/** Host plus a truncated path -- a full paid-endpoint URL overflows a card and buries the host. */
export function shortenUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  const path = url.pathname === '/' ? '' : url.pathname;
  const shortPath = path.length > 22 ? `${path.slice(0, 21)}…` : path;
  return `${url.host}${shortPath}`;
}
