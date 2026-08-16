import AnimatedContent from './AnimatedContent';
import SpotlightCard from './SpotlightCard';
import { ShieldAlertMark, ShieldCheckMark } from './icons';

const WITHOUT: readonly { lead: string; highlight: string }[] = [
  { lead: 'The paid path changes.', highlight: 'Nobody re-tests it.' },
  { lead: 'Payment failures are found by', highlight: 'customers.' },
  { lead: 'An agent on another chain', highlight: "can't even reach the service." },
];

const WITH: readonly { lead: string; highlight: string }[] = [
  { lead: 'Every release pays and probes', highlight: 'the real endpoint.' },
  { lead: 'Every result leaves', highlight: 'signed, version-scoped evidence.' },
  { lead: 'Funds bridge across chains', highlight: 'to pay any supported target.' },
];

export function ProblemSolution() {
  return (
    <section className="problem-solution" aria-label="The problem and how Shipyard402 solves it">
      <AnimatedContent distance={24} duration={0.72} threshold={0.16} animateOpacity={false}>
        <div className="section-heading">
          <div>
            <span className="eyebrow">THE PROBLEM</span>
            <h2>Paid endpoints break quietly. Nobody re-tests the money path.</h2>
          </div>
        </div>
      </AnimatedContent>

      <div className="compare-grid">
        <SpotlightCard className="compare-card compare-card--before" spotlightColor="rgba(255, 82, 82, 0.13)">
          <ShieldAlertMark className="compare-icon compare-icon--bad" />
          <span className="compare-label compare-label--before">WITHOUT SHIPYARD402</span>
          <ul>
            {WITHOUT.map((item) => (
              <li key={item.lead}>
                <span className="compare-mark compare-mark--bad" aria-hidden="true">
                  &#10005;
                </span>
                <span className="compare-line-text">
                  {item.lead} <strong className="compare-highlight compare-highlight--bad">{item.highlight}</strong>
                </span>
              </li>
            ))}
          </ul>
        </SpotlightCard>
        <SpotlightCard className="compare-card compare-card--after" spotlightColor="rgba(240, 196, 25, 0.15)">
          <ShieldCheckMark className="compare-icon compare-icon--good" />
          <span className="compare-label compare-label--after">WITH SHIPYARD402</span>
          <ul>
            {WITH.map((item) => (
              <li key={item.lead}>
                <span className="compare-mark compare-mark--good" aria-hidden="true">
                  &#10003;
                </span>
                <span className="compare-line-text">
                  {item.lead} <strong className="compare-highlight compare-highlight--good">{item.highlight}</strong>
                </span>
              </li>
            ))}
          </ul>
        </SpotlightCard>
      </div>
    </section>
  );
}
