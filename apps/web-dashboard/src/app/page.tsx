import type { CSSProperties } from 'react';

import AnimatedContent from '../components/AnimatedContent';
import LightRays from '../components/LightRays';
import { AppLinkButton } from '../components/app-link-button';
import { AnimatedWorkflow } from '../components/animated-workflow';
import { HeroRadar } from '../components/logo';
import { ProblemSolution } from '../components/problem-solution';
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
      <span className="shimmer-overlay" aria-hidden="true">
        {children}
      </span>
    </span>
  );
}

export default function HomePage() {
  return (
    <main>
      <SiteHeader homeHref="#top" />

      <section className="hero" id="top">
        <HeroRadar className="hero-radar" />
        <h1>
          <span className="hero-in" style={delayStyle(40)}>
            <ShimmerText>Prove the paid path.</ShimmerText>
          </span>
          <br />
          <em className="hero-in" style={delayStyle(80)}>
            <ShimmerText>Before users find the drift.</ShimmerText>
          </em>
        </h1>
        <p className="hero-copy hero-in" style={delayStyle(200)}>
          Real x402 purchases. Signed evidence. One exact service version.
        </p>
        <AppLinkButton size="md" className="hero-cta hero-in" style={delayStyle(300)}>
          Run a live test →
        </AppLinkButton>
      </section>

      <ProblemSolution />

      <ThreatCoverage />

      <AnimatedWorkflow />

      <ReplayDefenseDemo />

      <section className="run-section closing-cta">
        <LightRays
          raysOrigin="top-right"
          raysColor="#f0c419"
          raysSpeed={0.16}
          lightSpread={0.72}
          rayLength={1.5}
          fadeDistance={0.82}
          saturation={0.78}
          followMouse
          mouseInfluence={0.035}
          noiseAmount={0.025}
          distortion={0.035}
          className="closing-light-rays"
        />
        <AnimatedContent
          distance={22}
          duration={0.72}
          threshold={0.18}
          animateOpacity={false}
          className="closing-cta-content"
        >
          <div className="section-heading">
            <div>
              <span className="eyebrow">RELEASE GATE</span>
              <h2>Request a funded run</h2>
            </div>
          </div>
          <AppLinkButton size="md">Try the app →</AppLinkButton>
        </AnimatedContent>
      </section>

      <footer>
        <span>SHIPYARD402 / execution evidence, not assurance theater</span>
      </footer>
    </main>
  );
}
