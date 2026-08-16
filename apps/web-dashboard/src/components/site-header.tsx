import { SHOWCASE_NETWORKS } from '../lib/networks';
import { AppLinkButton } from './app-link-button';
import { NetworkLogo } from './network-marks';

export function SiteHeader({
  homeHref,
  showTryApp = true,
}: Readonly<{
  homeHref: string;
  /** Hide on the page the button would just link back to itself (the /app page). */
  showTryApp?: boolean;
}>) {
  return (
    <header className="nav-bar">
      <div className="nav-shell">
        <a className="brand" href={homeHref} aria-label="Shipyard402 home">
          <span className="brand-mark">
            {/* biome-ignore lint/performance/noImgElement: static asset, no next/image config needed for a 42px mark */}
            <img src="/logo-mark.png" alt="" className="brand-mark-icon" />
          </span>
          <span className="brand-wordmark">SHIPYARD402</span>
        </a>
        <span className="nav-signal" aria-hidden="true">
          <i />
          <b />
          <i />
        </span>
        <div className="nav-actions">
          <ul className="header-networks" aria-label="Supported networks">
            {SHOWCASE_NETWORKS.map((network) => (
              <li className="header-network" key={network.id} title={network.name}>
                <NetworkLogo networkId={network.id} size={18} className="header-network-logo" />
                <span className="header-network-label">{network.shortLabel}</span>
              </li>
            ))}
          </ul>
          {showTryApp && <AppLinkButton className="nav-try-button">Try the app</AppLinkButton>}
        </div>
      </div>
    </header>
  );
}
