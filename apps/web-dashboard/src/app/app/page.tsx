import AnimatedContent from '../../components/AnimatedContent';
import LightRays from '../../components/LightRays';
import { ReleaseRunForm } from '../../components/release-run-form';
import { SiteHeader } from '../../components/site-header';

export default function AppPage() {
  return (
    <main className="app-main">
      <SiteHeader homeHref="/" showTryApp={false} />

      <section className="run-section app-console-section">
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
        <div className="app-console-content">
          <AnimatedContent distance={18} duration={0.65} threshold={0.12} animateOpacity={false}>
            <div className="section-heading app-console-heading">
              <div>
                <span className="eyebrow">RELEASE GATE</span>
                <h2>Request a funded run</h2>
              </div>
            </div>
          </AnimatedContent>
          <AnimatedContent
            distance={22}
            duration={0.72}
            delay={0.08}
            threshold={0.08}
            animateOpacity={false}
            className="app-console-body"
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
