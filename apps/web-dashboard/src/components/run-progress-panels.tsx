'use client';

import type { AttestationResponse, EvidenceResponse, RunResponse } from '@shipyard402/public-api-client';

import { explorerTxUrl, ipfsGatewayUrl, shortHash } from '../hooks/use-run-progress';
import { GOAT_TESTNET3_CHAIN_ID } from '../lib/goat-wallet';
import { RadarMark } from './logo';
import { Pipeline } from './pipeline';
import { WalletPayPanel } from './wallet-pay-panel';

const STEPS = ['Customer payment', 'AI risk plan', 'Paid tool procurement', 'Deterministic evidence', 'GOAT attestation'];

/**
 * The pipeline + verdict + four-panel detail grid, shared between the standalone /runs/[id] page
 * and the inline "watch it happen right here" section on the run-request card -- one real
 * implementation of "what does a run's progress look like", not two that can drift apart.
 */
export function RunProgressPanels({
  runId,
  run,
  evidence,
  attestation,
  activeStep,
  isTerminal,
  tokenSymbol,
  tokenDecimals,
  connectedAddress,
}: Readonly<{
  runId: string;
  run: RunResponse;
  evidence: EvidenceResponse | null;
  attestation: AttestationResponse | null;
  activeStep: number;
  isTerminal: boolean;
  tokenSymbol?: string | undefined;
  tokenDecimals?: number | undefined;
  connectedAddress?: `0x${string}` | null | undefined;
}>) {
  const manifest = evidence?.publicManifest;

  return (
    <>
      <div className="workflow-section" aria-label="Run progress">
        <Pipeline steps={STEPS} activeIndex={activeStep} />
      </div>

      {isTerminal && (
        <div className={`run-verdict run-verdict--${run.run.status.toLowerCase()} state-in`}>
          <span className="run-verdict-label">{run.run.status.replace('DELIVERED_', '')}</span>
          <p>Run {runId} reached a terminal state. {manifest ? `Scenarios: ${manifest.scenarios.join(', ')}.` : ''}</p>
        </div>
      )}

      <div className="run-detail-grid">
        <div className="run-detail-panel glow-card state-in" data-state={activeStep >= 0 ? 'ready' : 'pending'} style={{ animationDelay: '0ms' }}>
          <span className="panel-label"><i>[01]</i> PAYMENT</span>
          <dl>
            <div><dt>Status</dt><dd>{run.payment.status}</dd></div>
            <div><dt>Next action</dt><dd>{run.payment.nextAction}</dd></div>
            {run.payment.orderId && <div><dt>GOAT Flow order</dt><dd className="mono">{run.payment.orderId}</dd></div>}
          </dl>
          {run.payment.paymentRequired?.accepts[0] && (
            <WalletPayPanel
              chainId={GOAT_TESTNET3_CHAIN_ID}
              challenge={run.payment.paymentRequired.accepts[0]}
              tokenSymbol={tokenSymbol}
              tokenDecimals={tokenDecimals}
              connectedAddress={connectedAddress}
            />
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
      </div>
    </>
  );
}
