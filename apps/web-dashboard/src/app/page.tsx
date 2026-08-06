import type { CSSProperties } from 'react';

import { AnimatedWorkflow } from '../components/animated-workflow';
import { NetworkMark } from '../components/icons';
import { HeroRadar } from '../components/logo';
import { ProblemSolution } from '../components/problem-solution';
import { ReleaseRunForm } from '../components/release-run-form';
import { ReplayDefenseDemo } from '../components/replay-defense-demo';
import { SiteHeader } from '../components/site-header';
import { ThreatCoverage } from '../components/threat-coverage';

function delayStyle(ms: number): CSSProperties {
  return { '--delay': `${ms}ms` } as CSSProperties;
}

/**
 * The base text renders normally (solid color, always fully visible) -- the shine is a separate,
 * absolutely-positioned duplicate layered on top with a mostly-transparent gradient clipped to its
 * own text shape. That way a shine that fails to render for any reason just means "no shine right
 * now", never "the headline is unreadable": the real text underneath is never touched.
 */
function ShimmerText({ children }: Readonly<{ children: string }>) {
  return (
    <span className="shimmer-text-wrap">
      {children}
      <span className="shimmer-overlay" aria-hidden="true">{children}</span>
    </span>
  );
}

export default function HomePage() {
  return (
    <main>
      <SiteHeader homeHref="#top" />

      <section className="hero" id="top">
        <HeroRadar className="hero-radar" />
        <div className="hero-network-badge hero-in" style={delayStyle(0)}>
          <NetworkMark className="hero-network-icon" />
          GOAT TESTNET3
        </div>
        <div className="eyebrow hero-in" style={delayStyle(40)}><i>[00]</i> AUTONOMOUS RELEASE ASSURANCE</div>
        <h1>
          <span className="hero-in" style={delayStyle(80)}><ShimmerText>Prove the paid path.</ShimmerText></span>
          <br />
          <em className="hero-in" style={delayStyle(200)}><ShimmerText>Before users find the drift.</ShimmerText></em>
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

      <ProblemSolution />

      <ThreatCoverage />

      <AnimatedWorkflow />

      <ReplayDefenseDemo />

      <section className="run-section">
        <div className="section-heading">
          <div>
            <span className="eyebrow"><i>[05]</i> RELEASE GATE</span>
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
