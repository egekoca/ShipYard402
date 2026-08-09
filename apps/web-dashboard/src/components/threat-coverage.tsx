import { FileWarning, History, ShieldOff } from 'lucide-react';
import AnimatedContent from './AnimatedContent';
import SpotlightCard from './SpotlightCard';

const THREATS = [
  {
    index: '01',
    title: 'Reusing a paid receipt',
    body: 'One payment receipt unlocks the resource more than once.',
    scenario: 'payment-proof-replay',
    icon: History,
  },
  {
    index: '02',
    title: 'Skipping payment entirely',
    body: 'The paid resource responds without a valid receipt.',
    scenario: 'unpaid-access-denial',
    icon: ShieldOff,
  },
  {
    index: '03',
    title: 'Accepting a forged receipt',
    body: 'A tampered receipt passes as genuine.',
    scenario: 'tampered-receipt-rejection',
    icon: FileWarning,
  },
];

export function ThreatCoverage() {
  return (
    <section className="threat-coverage" aria-label="What Shipyard402 checks for">
      <AnimatedContent distance={24} duration={0.72} threshold={0.16} animateOpacity={false}>
        <div className="section-heading">
          <div>
            <span className="eyebrow">WHAT WE CATCH</span>
            <h2>Three ways a paid endpoint quietly leaks money.</h2>
          </div>
        </div>
      </AnimatedContent>

      <div className="threat-grid">
        {THREATS.map((threat) => {
          const ThreatIcon = threat.icon;

          return (
            <SpotlightCard className="threat-card" spotlightColor="rgba(240, 196, 25, 0.15)" key={threat.scenario}>
              <div className="threat-card-top">
                <span className="threat-index">{threat.index}</span>
                <ThreatIcon className="threat-icon" aria-hidden="true" strokeWidth={1.8} />
              </div>
              <h3>{threat.title}</h3>
              <p>{threat.body}</p>
            </SpotlightCard>
          );
        })}
      </div>
    </section>
  );
}
