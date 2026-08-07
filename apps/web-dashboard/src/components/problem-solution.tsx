'use client';

import { useReveal } from '../hooks/use-reveal';
import { ShieldAlertMark, ShieldCheckMark } from './icons';

const WITHOUT: readonly { lead: string; highlight: string }[] = [
  { lead: 'Releases ship on hope.', highlight: 'Nobody re-tests the paid path after the code changes.' },
  { lead: 'A broken payment check is discovered by an angry customer,', highlight: 'not by you.' },
  { lead: 'The only proof anything was tested is', highlight: 'someone’s word for it.' },
];

const WITH: readonly { lead: string; highlight: string }[] = [
  { lead: 'Every release pays the real endpoint for real, then', highlight: 'tries to break it before a customer can.' },
  { lead: 'A broken payment check fails the release gate,', highlight: 'before it ever reaches someone paying.' },
  { lead: 'Every run leaves a signed, on-chain record:', highlight: 'what was tested, when, against which exact version.' },
];

export function ProblemSolution() {
  const [ref, visible] = useReveal<HTMLElement>();

  return (
    <section className={`problem-solution${visible ? ' is-visible' : ''}`} ref={ref} aria-label="The problem and how Shipyard402 solves it">
      <div className="section-heading">
        <div>
          <span className="eyebrow"><i>[01]</i> THE PROBLEM</span>
          <h2>Paid endpoints break quietly. Nobody re-tests the money path.</h2>
        </div>
        <p>Most releases are tested for correctness. Almost none are tested for whether a paying customer can still actually pay.</p>
      </div>

      <div className="compare-grid">
        <div className="compare-card compare-card--before glow-card">
          <ShieldAlertMark className="compare-icon compare-icon--bad" />
          <span className="compare-label compare-label--before">WITHOUT SHIPYARD402</span>
          <ul>
            {WITHOUT.map((item) => (
              <li key={item.lead}>
                <span className="compare-mark compare-mark--bad" aria-hidden="true">&#10005;</span>
                <span className="compare-line-text">{item.lead} <strong className="compare-highlight compare-highlight--bad">{item.highlight}</strong></span>
              </li>
            ))}
          </ul>
        </div>
        <div className="compare-card compare-card--after glow-card">
          <ShieldCheckMark className="compare-icon compare-icon--good" />
          <span className="compare-label compare-label--after">WITH SHIPYARD402</span>
          <ul>
            {WITH.map((item) => (
              <li key={item.lead}>
                <span className="compare-mark compare-mark--good" aria-hidden="true">&#10003;</span>
                <span className="compare-line-text">{item.lead} <strong className="compare-highlight compare-highlight--good">{item.highlight}</strong></span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
