import { ReleaseRunForm } from '../../components/release-run-form';
import { SiteHeader } from '../../components/site-header';

export default function AppPage() {
  return (
    <main>
      <SiteHeader homeHref="/" showTryApp={false} />

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
