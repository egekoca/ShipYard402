import { NETWORK_STATUS_LABEL, SHOWCASE_NETWORKS, type NetworkInfo } from '../lib/networks';
import AnimatedContent from './AnimatedContent';
import { NetworkLogo } from './network-marks';
import SpotlightCard from './SpotlightCard';

const ROLE_LABEL = {
  settlement: 'Settlement',
  'bridge-source': 'Bridge source',
  'bridge-destination': 'Bridge destination',
} as const;

/**
 * The headline of the expanded scope: Shipyard402 no longer lives on one chain. Each network shows
 * an honest status badge (Live / Beta / Coming) so the section can never read as "all of this is in
 * production" -- only GOAT Testnet3 has a real run history today.
 */
export function NetworksStrip() {
  return (
    <section className="networks-strip" aria-label="Blockchain networks Shipyard402 works across">
      <AnimatedContent distance={24} duration={0.72} threshold={0.16} animateOpacity={false}>
        <div className="section-heading">
          <div>
            <span className="eyebrow">RUNS ACROSS CHAINS</span>
            <h2>One engine. Several networks.</h2>
          </div>
        </div>
      </AnimatedContent>

      <div className="networks-grid">
        {SHOWCASE_NETWORKS.map((network, index) => (
          <AnimatedContent
            key={network.id}
            distance={22}
            duration={0.7}
            delay={0.06 * index}
            threshold={0.12}
            animateOpacity={false}
          >
            <NetworkCard network={network} />
          </AnimatedContent>
        ))}
      </div>
    </section>
  );
}

function NetworkCard({ network }: Readonly<{ network: NetworkInfo }>) {
  return (
    <SpotlightCard className={`network-card network-card--${network.status}`} spotlightColor="rgba(240, 196, 25, 0.14)">
      <div className="network-card-head">
        <NetworkLogo networkId={network.id} size={46} className="network-card-logo" />
        <div className="network-card-title">
          <strong>{network.name}</strong>
          <span className="network-chainid mono">chain {network.chainId}</span>
        </div>
        <StatusBadge status={network.status} />
      </div>
      <p className="network-card-blurb">{network.blurb}</p>
      <div className="network-role-tags">
        {network.roles.map((role) => (
          <span className="network-role-tag" key={role}>
            {ROLE_LABEL[role]}
          </span>
        ))}
      </div>
    </SpotlightCard>
  );
}

export function StatusBadge({ status }: Readonly<{ status: NetworkInfo['status'] }>) {
  return (
    <span className={`status-badge status-badge--${status}`}>
      <span className="status-dot" aria-hidden="true" />
      {NETWORK_STATUS_LABEL[status]}
    </span>
  );
}

/** Compact network chips for the hero: a mark + short label + status dot, one per showcase network. */
export function NetworkChips() {
  return (
    <ul className="network-chips" aria-label="Supported networks">
      {SHOWCASE_NETWORKS.map((network) => (
        <li className={`network-chip network-chip--${network.status}`} key={network.id}>
          <NetworkLogo networkId={network.id} size={18} className="network-chip-logo" />
          {network.shortLabel}
          <span className="network-chip-dot" aria-hidden="true" />
        </li>
      ))}
    </ul>
  );
}
