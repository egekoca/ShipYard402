import { ReleaseRunForm } from '../components/release-run-form';

const proofSteps = [
  'Customer payment',
  'AI risk plan',
  'Paid tool procurement',
  'Deterministic evidence',
  'GOAT attestation',
];

export default function HomePage() {
  return (
    <main>
      <header className="nav-shell">
        <a className="brand" href="#top" aria-label="Shipyard402 home">
          <span className="brand-mark">S402</span>
          <span>SHIPYARD402</span>
        </a>
        <div className="network-pill"><span /> GOAT MAINNET</div>
      </header>

      <section className="hero" id="top">
        <div className="eyebrow">AUTONOMOUS RELEASE ASSURANCE</div>
        <h1>Prove the paid path.<br /><em>Before users find the drift.</em></h1>
        <p className="hero-copy">
          Real x402 purchases, deterministic settlement checks, signed evidence, and expiry-bound
          attestations for one exact service version.
        </p>
        <div className="scope-note">
          <strong>What a PASS means</strong>
          <span>Tested under a named policy at a recorded time. It is not a blanket security certificate.</span>
        </div>
      </section>

      <section className="workflow" aria-label="Assurance workflow">
        {proofSteps.map((step, index) => (
          <div className="workflow-step" key={step}>
            <span>{String(index + 1).padStart(2, '0')}</span>
            <p>{step}</p>
          </div>
        ))}
      </section>

      <section className="run-section">
        <div className="section-heading">
          <div>
            <span className="eyebrow">RELEASE GATE</span>
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
