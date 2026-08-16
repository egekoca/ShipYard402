'use client';

import { ECOSYSTEM_DIRECTORY_URL, ECOSYSTEM_SHOWCASE, type EcosystemService } from './ecosystem-showcase-data';
import { monogram } from './service-marketplace';

/**
 * Discovery-only sample of real x402 services in the wild. Read-only by design: every card links
 * out to the operator's own site and nothing here can start a run, because these operators never
 * consented to having their payment logic attacked (see ecosystem-showcase-data.ts). The testable
 * directory above is the consented surface; this is here to show the ecosystem is real.
 */
export function EcosystemShowcase() {
  return (
    <section className="showcase" aria-label="x402 ecosystem showcase">
      <header className="showcase-header">
        <div>
          <span className="panel-label">MORE x402 SERVICES IN THE WILD</span>
          <p className="showcase-intro">
            A sample of live x402 APIs across the ecosystem. These run on Base/Solana mainnet and aren&apos;t testable
            through Shipyard — to run assurance on one, its operator lists it above or registers it through the form.
          </p>
        </div>
        <a className="link-toggle" href={ECOSYSTEM_DIRECTORY_URL} target="_blank" rel="noreferrer">
          Browse the full directory ↗
        </a>
      </header>
      <ul className="showcase-grid">
        {ECOSYSTEM_SHOWCASE.map((service) => (
          <li key={service.url}>
            <ShowcaseCard service={service} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function ShowcaseCard({ service }: Readonly<{ service: EcosystemService }>) {
  return (
    <a className="showcase-card" href={service.url} target="_blank" rel="noreferrer">
      <div className="showcase-card-head">
        <span className="showcase-logo" aria-hidden="true">
          {monogram(service.name)}
        </span>
        <strong>{service.name}</strong>
      </div>
      <div className="showcase-meta">
        <span className="showcase-networks">{service.networks.join(' · ')}</span>
        <span className="showcase-price mono">{service.priceLabel}</span>
      </div>
      <span className="showcase-cta">Visit ↗</span>
    </a>
  );
}
