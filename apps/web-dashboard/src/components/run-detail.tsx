'use client';

import {
  ShipyardApiClient,
  ShipyardApiError,
  type AttestationResponse,
  type EvidenceResponse,
  type RunResponse,
} from '@shipyard402/public-api-client';
import { useEffect, useMemo, useRef, useState } from 'react';

import { RadarMark } from './logo';
import { Pipeline } from './pipeline';

const STEPS = ['Customer payment', 'AI risk plan', 'Paid tool procurement', 'Deterministic evidence', 'GOAT attestation'];
const POLL_MS = 4000;
const TERMINAL_STATUSES = new Set([
  'DELIVERED_PASS', 'DELIVERED_CONDITIONAL', 'DELIVERED_FAIL', 'DELIVERED_INCONCLUSIVE', 'CANCELLED', 'EXPIRED',
]);

function stepIndexForStatus(status: string): number {
  if (['DRAFT', 'QUOTED', 'PAYMENT_REQUIRED'].includes(status)) return -1;
  if (status === 'FUNDED') return 0;
  if (['ANALYZING', 'PLAN_COMPILED'].includes(status)) return 1;
  if (['PROCURING', 'EXECUTING', 'REPLANNING'].includes(status)) return 2;
  if (status === 'EVIDENCE_BUILDING') return 3;
  if (status === 'ATTESTING') return 4;
  return 5;
}

function explorerTxUrl(chainId: number, txHash: string): string {
  const base = chainId === 2345 ? 'https://explorer.goat.network' : 'https://explorer.testnet3.goat.network';
  return `${base}/tx/${txHash}`;
}

export function RunDetail({ runId }: Readonly<{ runId: string }>) {
  const [run, setRun] = useState<RunResponse | null>(null);
  const [evidence, setEvidence] = useState<EvidenceResponse | null>(null);
  const [attestation, setAttestation] = useState<AttestationResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastPolledAt, setLastPolledAt] = useState<Date | null>(null);
  const client = useMemo(
    () => new ShipyardApiClient(process.env['NEXT_PUBLIC_SHIPYARD_API_URL'] ?? 'http://127.0.0.1:3001'),
    [],
  );
  const stopped = useRef(false);

  useEffect(() => {
    stopped.current = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      try {
        const [runResponse, evidenceResponse, attestationResponse] = await Promise.all([
          client.getRun(runId),
          client.getEvidence(runId),
          client.getAttestation(runId),
        ]);
        if (stopped.current) return;
        setRun(runResponse);
        setEvidence(evidenceResponse);
        setAttestation(attestationResponse);
        setError(null);
        setLastPolledAt(new Date());
      } catch (caught) {
        if (stopped.current) return;
        setError(caught instanceof ShipyardApiError ? `${caught.code}: ${caught.message}` : 'Could not reach the Shipyard402 API');
      }
      if (stopped.current) return;
      const isTerminal = run && TERMINAL_STATUSES.has(run.run.status);
      timeout = setTimeout(poll, isTerminal ? POLL_MS * 4 : POLL_MS);
    }

    void poll();
    return () => {
      stopped.current = true;
      if (timeout) clearTimeout(timeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, client, run?.run.status]);

  const activeStep = run ? stepIndexForStatus(run.run.status) : -1;
  const isTerminal = run ? TERMINAL_STATUSES.has(run.run.status) : false;
  const manifest = evidence?.publicManifest;

  return (
    <main className="run-detail">
      <header className="nav-shell">
        <a className="brand" href="/" aria-label="Shipyard402 home">
          <span className="brand-mark"><RadarMark className="brand-mark-icon" /></span>
          <span>SHIPYARD402</span>
        </a>
        <div className="network-pill"><span /> GOAT TESTNET3</div>
      </header>

      <section className="run-detail-hero">
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
        <>
          <section className="workflow-section" aria-label="Run progress">
            <Pipeline steps={STEPS} activeIndex={activeStep} />
          </section>

          {isTerminal && (
            <section className={`run-verdict run-verdict--${run.run.status.toLowerCase()} state-in`}>
              <span className="run-verdict-label">{run.run.status.replace('DELIVERED_', '')}</span>
              <p>Run {runId} reached a terminal state. {manifest ? `Scenarios: ${manifest.scenarios.join(', ')}.` : ''}</p>
            </section>
          )}

          <section className="run-detail-grid">
            <div className="run-detail-panel state-in" data-state={activeStep >= 0 ? 'ready' : 'pending'} style={{ animationDelay: '0ms' }}>
              <span className="panel-label"><i>[01]</i> PAYMENT</span>
              <dl>
                <div><dt>Status</dt><dd>{run.payment.status}</dd></div>
                <div><dt>Next action</dt><dd>{run.payment.nextAction}</dd></div>
                {run.payment.orderId && <div><dt>GOAT Flow order</dt><dd className="mono">{run.payment.orderId}</dd></div>}
              </dl>
            </div>

            <div
              className="run-detail-panel state-in"
              data-state={!evidence ? 'pending' : evidence.publicManifest.result === 'FAIL' ? 'fail' : 'ready'}
              style={{ animationDelay: '90ms' }}
            >
              <span className="panel-label"><i>[02]</i> EVIDENCE</span>
              {!evidence && (
                <div className="panel-empty">
                  <RadarMark className="panel-empty-icon" />
                  <p>Not built yet — appears once the run reaches EVIDENCE_BUILDING.</p>
                </div>
              )}
              {evidence && (
                <>
                  <dl>
                    <div><dt>Risk level</dt><dd>{evidence.publicManifest.riskLevel}</dd></div>
                    <div><dt>Result</dt><dd>{evidence.publicManifest.result}</dd></div>
                    <div><dt>Evidence root</dt><dd className="mono">{shortHash(evidence.evidenceRoot)}</dd></div>
                  </dl>
                  <ul className="run-detail-receipts">
                    {evidence.publicManifest.toolReceipts.map((receipt) => (
                      <li key={receipt.scenarioId}>
                        <span className={`receipt-result receipt-result--${receipt.result.toLowerCase()}`}>{receipt.result}</span>
                        <span className="mono">{receipt.scenarioId}</span>
                        <a
                          className="explorer-link"
                          href={explorerTxUrl(receipt.chainId, receipt.chainTransactionHash)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          payment tx ↗
                        </a>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>

            <div className="run-detail-panel state-in" data-state={attestation ? 'ready' : 'pending'} style={{ animationDelay: '180ms' }}>
              <span className="panel-label"><i>[03]</i> ON-CHAIN ATTESTATION</span>
              {!attestation && (
                <div className="panel-empty">
                  <RadarMark className="panel-empty-icon" />
                  <p>Not submitted yet — appears once the run reaches ATTESTING.</p>
                </div>
              )}
              {attestation && (
                <dl>
                  <div><dt>Registry</dt><dd className="mono">{shortHash(attestation.registryAddress)}</dd></div>
                  <div>
                    <dt>Transaction</dt>
                    <dd>
                      <a className="explorer-link" href={explorerTxUrl(attestation.chainId, attestation.transactionHash)} target="_blank" rel="noreferrer">
                        {shortHash(attestation.transactionHash)} ↗
                      </a>
                    </dd>
                  </div>
                  <div><dt>Expires</dt><dd>{new Date(attestation.expiresAt).toLocaleString()}</dd></div>
                </dl>
              )}
            </div>
          </section>
        </>
      )}

      <footer>
        <span>SHIPYARD402 / execution evidence, not assurance theater</span>
        <span>Frontend contains no merchant credentials or signer access.</span>
      </footer>
    </main>
  );
}

function shortHash(value: string): string {
  return `${value.slice(0, 10)}…${value.slice(-6)}`;
}
