'use client';

import { useRunProgress } from '../hooks/use-run-progress';
import { RunProgressPanels } from './run-progress-panels';
import { SiteHeader } from './site-header';

export function RunDetail({ runId }: Readonly<{ runId: string }>) {
  const { run, plan, evidence, attestation, error, lastPolledAt, activeStep, isTerminal } = useRunProgress(runId);

  return (
    <main className="run-detail">
      <SiteHeader homeHref="/" showTryApp={false} />

      <section className="run-detail-hero">
        <a className="run-detail-back" href="/app">← Back to your runs</a>
        <span className="eyebrow"><i>[RUN]</i> RELEASE RUN{!isTerminal && run ? <span className="live-pulse" aria-hidden="true" /> : null}</span>
        <h1 className="mono run-detail-id">{runId}</h1>
        {lastPolledAt && (
          <p className="run-detail-polled">Last updated {lastPolledAt.toLocaleTimeString()}{!isTerminal ? ' — refreshing automatically' : ''}</p>
        )}
        {error && <div className="error-card state-in"><strong>Request blocked</strong><p>{error}</p></div>}
      </section>

      {!run && !error && (
        <section className="run-detail-loading">
          <div className="radar"><span className="radar-sweep" /></div>
          <p>Looking up run…</p>
        </section>
      )}

      {run && (
        <RunProgressPanels
          runId={runId}
          run={run}
          plan={plan}
          evidence={evidence}
          attestation={attestation}
          activeStep={activeStep}
          isTerminal={isTerminal}
        />
      )}

      <footer>
        <span>SHIPYARD402 / execution evidence, not assurance theater</span>
        <span>Frontend contains no merchant credentials or signer access.</span>
      </footer>
    </main>
  );
}
