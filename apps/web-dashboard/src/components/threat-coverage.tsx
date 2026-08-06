'use client';

import { useReveal } from '../hooks/use-reveal';

const THREATS = [
  {
    index: '01',
    title: 'Reusing a paid receipt',
    body: 'A customer pays once, then presents that same payment receipt again to pull the paid resource a second time -- a tenth time, forever, for free -- because nothing tracks whether it was already spent.',
    scenario: 'payment-proof-replay',
  },
  {
    index: '02',
    title: 'Skipping payment entirely',
    body: 'The paid resource comes back even when no valid receipt is presented at all. The 402 "payment required" challenge exists on paper; nothing actually enforces it.',
    scenario: 'unpaid-access-denial',
  },
  {
    index: '03',
    title: 'Accepting a forged receipt',
    body: 'A tampered or corrupted receipt is accepted as if it were genuine, because the service checks that something was presented -- not that what was presented is real.',
    scenario: 'tampered-receipt-rejection',
  },
];

export function ThreatCoverage() {
  const [ref, visible] = useReveal<HTMLElement>();

  return (
    <section className={`threat-coverage${visible ? ' is-visible' : ''}`} ref={ref} aria-label="What Shipyard402 checks for">
      <div className="section-heading">
        <div>
          <span className="eyebrow"><i>[01]</i> WHAT WE CATCH</span>
          <h2>Three ways a paid endpoint quietly leaks money.</h2>
        </div>
        <p>Every run pays the target for real, then really tries all three against it -- not a checklist, an attempt.</p>
      </div>

      <div className="threat-grid">
        {THREATS.map((threat, i) => (
          <div className="threat-card" style={{ '--delay': `${i * 110}ms` } as React.CSSProperties} key={threat.scenario}>
            <span className="threat-index">{threat.index}</span>
            <h3>{threat.title}</h3>
            <p>{threat.body}</p>
            <code className="threat-scenario">{threat.scenario}</code>
          </div>
        ))}
      </div>
    </section>
  );
}
