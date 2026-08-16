import { CircleDot, FileSignature, Radar, Wallet } from 'lucide-react';

import AnimatedContent from '../../components/AnimatedContent';
import LightRays from '../../components/LightRays';
import { NetworkChips } from '../../components/networks-strip';
import { ReleaseRunForm } from '../../components/release-run-form';
import { SiteHeader } from '../../components/site-header';

const WORKFLOW_STEPS = [
  { n: '01', icon: Radar, label: 'Pick a target', sub: 'Listed, or your own' },
  { n: '02', icon: Wallet, label: 'Fund the run', sub: 'From your wallet' },
  { n: '03', icon: CircleDot, label: 'Watch it run', sub: 'Real payment, live attacks' },
  { n: '04', icon: FileSignature, label: 'Signed proof', sub: 'PASS/FAIL, on-chain' },
] as const;

export default function AppPage() {
  return (
    <main className="app-main console-main">
      <SiteHeader homeHref="/" showTryApp={false} />

      <section className="console-shell">
        <LightRays
          raysOrigin="top-right"
          raysColor="#f0c419"
          raysSpeed={0.12}
          lightSpread={0.65}
          rayLength={1.25}
          fadeDistance={0.72}
          saturation={0.7}
          followMouse
          mouseInfluence={0.025}
          noiseAmount={0.02}
          distortion={0.025}
          className="app-console-rays"
        />

        <div className="console-inner">
          <AnimatedContent distance={18} duration={0.65} threshold={0.12} animateOpacity={false}>
            <header className="console-head">
              <div className="console-head-lead">
                <span className="console-status">
                  <span className="console-status-dot" aria-hidden="true" />
                  RELEASE GATE · LIVE
                </span>
                <h1 className="console-title">Request a funded run</h1>
                <p className="console-lede">Fund on GOAT, pay a target on any chain. Signed on-chain either way.</p>
              </div>
              <NetworkChips />
            </header>
          </AnimatedContent>

          <AnimatedContent distance={20} duration={0.7} delay={0.05} threshold={0.1} animateOpacity={false}>
            <ol className="console-steps" aria-label="How a run works">
              {WORKFLOW_STEPS.map((step) => {
                const Icon = step.icon;
                return (
                  <li className="console-step" key={step.n}>
                    <span className="console-step-n mono">{step.n}</span>
                    <Icon className="console-step-icon" strokeWidth={1.7} aria-hidden="true" />
                    <span className="console-step-label">{step.label}</span>
                    <span className="console-step-sub">{step.sub}</span>
                  </li>
                );
              })}
            </ol>
          </AnimatedContent>

          <AnimatedContent
            distance={22}
            duration={0.72}
            delay={0.1}
            threshold={0.06}
            animateOpacity={false}
            className="console-workspace"
          >
            <ReleaseRunForm />
          </AnimatedContent>
        </div>
      </section>

      <footer className="app-footer">
        <span>SHIPYARD402 / execution evidence, not assurance theater</span>
      </footer>
    </main>
  );
}
