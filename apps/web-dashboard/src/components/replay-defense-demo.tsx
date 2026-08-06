'use client';

import { useEffect, useState } from 'react';

import { useReveal } from '../hooks/use-reveal';

type Phase = 'idle' | 'sending' | 'delivered' | 'replaying' | 'result';

const PHASES: readonly Phase[] = ['idle', 'sending', 'delivered', 'replaying', 'result', 'result'];
const TICK_MS = 1100;

const PHASE_COPY: Record<Phase, string> = {
  idle: 'Payment receipt in hand',
  sending: 'Presenting receipt to the paid endpoint',
  delivered: 'Delivered once, receipt spent',
  replaying: 'Same receipt, presented again',
  result: 'Result',
};

export function ReplayDefenseDemo() {
  const [ref, visible] = useReveal<HTMLElement>();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!visible) return;
    const id = window.setInterval(() => setTick((current) => (current + 1) % PHASES.length), TICK_MS);
    return () => window.clearInterval(id);
  }, [visible]);

  const phase = PHASES[tick]!;
  const showResult = phase === 'result';

  return (
    <section className={`replay-demo${visible ? ' is-visible' : ''}`} ref={ref} aria-label="Payment-proof replay check">
      <div className="section-heading">
        <div>
          <span className="eyebrow"><i>[04]</i> DETERMINISTIC CHECK</span>
          <h2>One receipt. One delivery.</h2>
        </div>
        <p>
          The same replay probe the release runner performs against a live paid endpoint: present a spent
          payment receipt a second time and see whether the service notices.
        </p>
      </div>

      <div className="replay-lanes">
        <ReplayLane
          version="V1"
          label="No redemption check"
          phase={phase}
          showResult={showResult}
          outcome="FAIL"
        />
        <ReplayLane
          version="V2"
          label="Redemption tracked per receipt"
          phase={phase}
          showResult={showResult}
          outcome="PASS"
        />
      </div>
    </section>
  );
}

function ReplayLane({
  version,
  label,
  phase,
  showResult,
  outcome,
}: Readonly<{ version: string; label: string; phase: Phase; showResult: boolean; outcome: 'PASS' | 'FAIL' }>) {
  const exploited = outcome === 'FAIL';
  return (
    <div className={`replay-lane glow-card replay-lane--${version.toLowerCase()}${showResult ? ' has-result' : ''}`}>
      <div className="replay-lane-head">
        <span className="replay-version">{version}</span>
        <span className="replay-label">{label}</span>
      </div>

      <div className="replay-track">
        <span className="replay-node replay-node--client">Client</span>
        <span className={`replay-packet${phase === 'sending' || phase === 'replaying' ? ' is-moving' : ''}${phase === 'replaying' ? ' is-replay' : ''}`} />
        <span className="replay-node replay-node--service">Service</span>
      </div>

      <p className="replay-status">{PHASE_COPY[phase]}</p>

      <div className={`replay-result replay-result--${exploited ? 'fail' : 'pass'}`} aria-hidden={!showResult}>
        <span className="replay-result-code">{exploited ? '200' : '409'}</span>
        <span className="replay-result-label">{exploited ? 'REPLAY ACCEPTED' : 'REPLAY REJECTED'}</span>
        <span className="replay-result-verdict">{outcome}</span>
      </div>
    </div>
  );
}
