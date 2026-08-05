import type { CSSProperties } from 'react';

import { AnimatedWorkflow } from '../components/animated-workflow';
import { LogoMark, LogoWatermark } from '../components/logo';
import { ReleaseRunForm } from '../components/release-run-form';
import { ReplayDefenseDemo } from '../components/replay-defense-demo';

function delayStyle(ms: number): CSSProperties {
  return { '--delay': `${ms}ms` } as CSSProperties;
}

export default function HomePage() {
  return (
    <main>
      <header className="nav-shell">
        <a className="brand" href="#top" aria-label="Shipyard402 home">
          <span className="brand-mark"><LogoMark className="brand-mark-icon" /></span>
          <span>SHIPYARD402</span>
        </a>
        <div className="network-pill"><span /> GOAT MAINNET</div>
      </header>

      <section className="hero" id="top">
        <LogoWatermark className="hero-logo" />
        <div className="eyebrow hero-in" style={delayStyle(0)}><i>[00]</i> AUTONOMOUS RELEASE ASSURANCE</div>
        <h1>
          <span className="hero-in" style={delayStyle(80)}>Prove the paid path.</span>
          <br />
          <em className="hero-in" style={delayStyle(200)}>Before users find the drift.</em>
        </h1>
        <p className="hero-copy hero-in" style={delayStyle(340)}>
          Real x402 purchases, deterministic settlement checks, signed evidence, and expiry-bound
          attestations for one exact service version.
        </p>
        <div className="scope-note hero-in" style={delayStyle(460)}>
          <strong>What a PASS means</strong>
          <span>Tested under a named policy at a recorded time. It is not a blanket security certificate.</span>
        </div>
      </section>

      <AnimatedWorkflow />

      <ReplayDefenseDemo />

      <section className="run-section">
        <div className="section-heading">
          <div>
            <span className="eyebrow"><i>[03]</i> RELEASE GATE</span>
            <h2>Request a funded run</h2>
          </div>
          <p>The quote is created from a verified merchant capability. No token or recipient is assumed by this interface.</p>
        </div>
        <ReleaseRunForm />
      </section>

      <footer>
        <span>SHIPYARD402 / execution evidence, not assurance theater</span>
        <span>Frontend contains no merchant credentials or signer access.</span>
      </footer>
    </main>
  );
}
