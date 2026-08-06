'use client';

import {
  ShipyardApiClient,
  ShipyardApiError,
  type AttestationResponse,
  type EvidenceResponse,
  type RunResponse,
} from '@shipyard402/public-api-client';
import { useEffect, useMemo, useRef, useState } from 'react';

import { GOAT_TESTNET3_CHAIN_ID } from '../lib/goat-wallet';
import { RadarMark } from './logo';
import { Pipeline } from './pipeline';
import { WalletPayPanel } from './wallet-pay-panel';

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

function ipfsGatewayUrl(uri: string): string {
  return uri.startsWith('ipfs://') ? `https://ipfs.io/ipfs/${uri.slice('ipfs://'.length)}` : uri;
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
          {/* eslint-disable-next-line @next/next/no-img-element -- static asset, no next/image config needed for a 42px mark */}
          <span className="brand-mark"><img src="/logo-mark.png" alt="" className="brand-mark-icon" /></span>
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
            <div className="run-detail-panel glow-card state-in" data-state={activeStep >= 0 ? 'ready' : 'pending'} style={{ animationDelay: '0ms' }}>
              <span className="panel-label"><i>[01]</i> PAYMENT</span>
              <dl>
                <div><dt>Status</dt><dd>{run.payment.status}</dd></div>
                <div><dt>Next action</dt><dd>{run.payment.nextAction}</dd></div>
                {run.payment.orderId && <div><dt>GOAT Flow order</dt><dd className="mono">{run.payment.orderId}</dd></div>}
              </dl>
              {run.payment.paymentRequired?.accepts[0] && (
                <WalletPayPanel chainId={GOAT_TESTNET3_CHAIN_ID} challenge={run.payment.paymentRequired.accepts[0]} />
              )}
            </div>

            <div className="run-detail-panel glow-card state-in" data-state={manifest ? 'ready' : 'pending'} style={{ animationDelay: '90ms' }}>
              <span className="panel-label"><i>[02]</i> AI RISK PLAN</span>
              {!manifest && (
                <div className="panel-empty">
                  <RadarMark className="panel-empty-icon" />
                  <p>Not available yet — the AI&apos;s proposal and the compiled plan appear once the run reaches EVIDENCE_BUILDING.</p>
                </div>
              )}
              {manifest && (
                <>
                  <dl>
                    <div><dt>Risk level (compiled)</dt><dd>{manifest.riskLevel}</dd></div>
                    <div><dt>Tool budget (compiled)</dt><dd className="mono">{manifest.toolBudgetAtomic}</dd></div>
                    <div><dt>Scenarios run</dt><dd>{manifest.scenarios.join(', ')}</dd></div>
                  </dl>
                  <p className="ai-rationale">{manifest.rationale}</p>
                  {manifest.aiProposal ? (
                    <div className="ai-proposal-diff">
                      <span className="panel-sublabel">AI PROPOSED THIS (ADVISORY, NOT BINDING)</span>
                      <dl>
                        <div><dt>Risk level</dt><dd>{manifest.aiProposal.riskLevel}</dd></div>
                        <div><dt>Scenarios</dt><dd>{manifest.aiProposal.proposedScenarios.join(', ')}</dd></div>
                        <div><dt>Budget</dt><dd className="mono">{manifest.aiProposal.proposedToolBudgetAtomic}</dd></div>
                      </dl>
                    </div>
                  ) : (
                    <p className="ai-rationale">AI proposal not recorded for this run (resumed from an older checkpoint).</p>
                  )}
                </>
              )}
            </div>

            <div
              className="run-detail-panel glow-card state-in"
              data-state={!evidence ? 'pending' : evidence.publicManifest.result === 'FAIL' ? 'fail' : 'ready'}
              style={{ animationDelay: '135ms' }}
            >
              <span className="panel-label"><i>[03]</i> EVIDENCE</span>
              {!evidence && (
                <div className="panel-empty">
                  <RadarMark className="panel-empty-icon" />
                  <p>Not built yet — appears once the run reaches EVIDENCE_BUILDING.</p>
                </div>
              )}
              {evidence && (
                <>
                  <dl>
                    <div><dt>Result</dt><dd>{evidence.publicManifest.result}</dd></div>
                    <div><dt>Evidence root</dt><dd className="mono">{shortHash(evidence.evidenceRoot)}</dd></div>
                    <div>
                      <dt>Evidence pack</dt>
                      <dd>
                        <a className="explorer-link" href={ipfsGatewayUrl(evidence.uri)} target="_blank" rel="noreferrer">
                          view on IPFS ↗
                        </a>
                      </dd>
                    </div>
                  </dl>
                  <ul className="run-detail-receipts">
                    {evidence.publicManifest.toolReceipts.map((receipt) => {
                      const trace = manifest?.scenarioTraces?.find((candidate) => candidate.scenarioId === receipt.scenarioId);
                      return (
                        <li key={receipt.scenarioId}>
                          <div className="receipt-row">
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
                          </div>
                          {trace && trace.attempts.length > 0 && (
                            <ol className="scenario-trace">
                              {trace.attempts.map((attempt, index) => (
                                <li key={`${attempt.phase}-${index}`}>
                                  <span className="trace-phase mono">{attempt.phase}</span>
                                  <span>tool agent → target agent, {attempt.statusCode ?? 'no response'}</span>
                                  {attempt.deliveryConfirmed !== undefined && (
                                    <span>{attempt.deliveryConfirmed ? 'delivery confirmed' : 'delivery rejected'}</span>
                                  )}
                                  <span className="mono">req {shortHash(attempt.requestHash)}</span>
                                  {attempt.responseHash && <span className="mono">res {shortHash(attempt.responseHash)}</span>}
                                </li>
                              ))}
                            </ol>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </div>

            <div className="run-detail-panel glow-card state-in" data-state={attestation ? 'ready' : 'pending'} style={{ animationDelay: '180ms' }}>
              <span className="panel-label"><i>[04]</i> ON-CHAIN ATTESTATION</span>
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
