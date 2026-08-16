import { ShieldCheck } from 'lucide-react';

import { SHOWCASE_NETWORKS } from '../lib/networks';
import { NetworkLogo } from './network-marks';

/** A lightweight route diagram: product shape without presenting fabricated run data. */
export function HeroRoute() {
  return (
    <div className="hero-route" aria-hidden="true">
      <div className="hero-route-meta">
        <span className="hero-route-live">
          <i /> GOAT TESTNET3 LIVE
        </span>
        <span>SIGNED EVIDENCE</span>
      </div>

      <div className="hero-route-map">
        <span className="hero-route-orbit hero-route-orbit--outer" />
        <span className="hero-route-orbit hero-route-orbit--inner" />
        <span className="hero-route-link hero-route-link--goat">
          <i />
        </span>
        <span className="hero-route-link hero-route-link--bnb">
          <i />
        </span>
        <span className="hero-route-link hero-route-link--bot">
          <i />
        </span>

        <div className="hero-route-core">
          <ShieldCheck strokeWidth={1.6} />
          <strong>VERIFIED</strong>
          <small>public proof</small>
        </div>

        {SHOWCASE_NETWORKS.map((network, index) => (
          <div className={`hero-route-node hero-route-node--${index}`} key={network.id}>
            <NetworkLogo networkId={network.id} size={34} className="hero-route-logo" />
            <span>{network.shortLabel}</span>
          </div>
        ))}
      </div>

      <div className="hero-route-steps">
        <span>
          <b>01</b> PAY
        </span>
        <i />
        <span>
          <b>02</b> ATTACK
        </span>
        <i />
        <span>
          <b>03</b> PROVE
        </span>
      </div>
    </div>
  );
}
