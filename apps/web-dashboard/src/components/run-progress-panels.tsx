'use client';

import type { AttestationResponse, EvidenceResponse, PlanResponse, RunResponse } from '@shipyard402/public-api-client';
import { useState } from 'react';

import { explorerTxUrl, formatDurationEstimate, ipfsGatewayUrl, shortHash, useStepDurationStats } from '../hooks/use-run-progress';
import { GOAT_TESTNET3_CHAIN_ID } from '../lib/goat-wallet';
import { RadarMark } from './logo';
import { Pipeline } from './pipeline';
import { WalletPayPanel } from './wallet-pay-panel';

const STEPS = ['Customer payment', 'AI risk plan', 'Paid tool procurement', 'Deterministic evidence', 'GOAT attestation'];
/** Same order as STEPS -- maps each stepper label to the step-duration-stats bucket it corresponds to. */
const STEP_DURATION_BUCKETS = ['payment', 'plan', 'procurement', 'evidence', 'attestation'] as const;

type PanelState = 'pending' | 'active' | 'ready' | 'fail';
type PanelKey = 'payment' | 'plan' | 'evidence' | 'attestation';

/**
 * The pipeline + verdict + four-panel detail grid, shared between the standalone /runs/[id] page
 * and the inline "watch it happen right here" section on the run-request card -- one real
 * implementation of "what does a run's progress look like", not two that can drift apart.
 *
 * Each panel is collapsed to a one-line summary by default and expands (full width, pushing the
 * others down) on click -- four panels of full detail all open at once read as noise, not signal.
 * Panel state is three-way, not just "waiting vs done": pending (queued, hasn't started), active
 * (the run is on this step *right now* -- a spinning mark says so instead of leaving the card
 * static and silent), and ready. The AI risk plan and evidence panels in particular stay "active"
 * well past their nominal pipeline step, because their real content only exists once the evidence
 * pack is actually built -- showing that as still-in-progress is honest; a static "not available"
 * label while the run visibly keeps moving is not.
 */
export function RunProgressPanels({
  runId,
  run,
  plan,
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
  plan: PlanResponse | null;
  evidence: EvidenceResponse | null;
  attestation: AttestationResponse | null;
  activeStep: number;
  isTerminal: boolean;
  tokenSymbol?: string | undefined;
  tokenDecimals?: number | undefined;
  connectedAddress?: `0x${string}` | null | undefined;
}>) {
  const stepDurationStats = useStepDurationStats();
  const stepEtas: readonly (string | null)[] = STEP_DURATION_BUCKETS.map((bucket) => {
    const ms = stepDurationStats?.medianMillisecondsByStep[bucket];
    return ms ? formatDurationEstimate(ms) : null;
  });
  const manifest = evidence?.publicManifest;
  // The plan panel's own content -- prefer the early plan endpoint (available right after
  // PLAN_COMPILED) over waiting for the evidence pack (only built much later); once evidence
  // exists its manifest carries the same fields plus scenarioTraces used elsewhere, but for this
  // panel's own display the earliest available source wins.
  const planView = plan ?? manifest;
  const [expanded, setExpanded] = useState<Partial<Record<PanelKey, boolean>>>({});
  const toggle = (key: PanelKey) => setExpanded((current) => ({ ...current, [key]: !current[key] }));

  const paymentState: PanelState = activeStep >= 0 ? 'ready' : 'active';
  const planState: PanelState = planView ? 'ready' : activeStep >= 1 ? 'active' : 'pending';
  const evidenceState: PanelState = evidence
    ? (evidence.publicManifest.result === 'FAIL' ? 'fail' : 'ready')
    : activeStep >= 2 ? 'active' : 'pending';
  const attestationState: PanelState = attestation ? 'ready' : activeStep >= 4 ? 'active' : 'pending';

  return (
    <>
      <div className="workflow-section" aria-label="Run progress">
        <Pipeline steps={STEPS} activeIndex={activeStep} stepEtas={stepEtas} />
      </div>

      {isTerminal && (
        <div className={`run-verdict run-verdict--${run.run.status.toLowerCase()} state-in`}>
          <span className="run-verdict-label">{run.run.status.replace('DELIVERED_', '')}</span>
          <p>Run {runId} reached a terminal state. {manifest ? `Scenarios: ${manifest.scenarios.join(', ')}.` : ''}</p>
        </div>
      )}

      <div className="run-detail-grid">
        <Panel index="01" label="PAYMENT" state={paymentState} expanded={Boolean(expanded.payment)} onToggle={() => toggle('payment')}
          summary={paymentState === 'ready' ? run.payment.status : 'Awaiting payment'}
          action={run.payment.paymentRequired?.accepts[0] && (
            <WalletPayPanel
              chainId={GOAT_TESTNET3_CHAIN_ID}
              challenge={run.payment.paymentRequired.accepts[0]}
              tokenSymbol={tokenSymbol}
              tokenDecimals={tokenDecimals}
              connectedAddress={connectedAddress}
            />
          )}
        >
          <dl>
            <div><dt>Status</dt><dd>{run.payment.status}</dd></div>
            <div><dt>Next action</dt><dd>{run.payment.nextAction}</dd></div>
            {run.payment.orderId && <div><dt>GOAT Flow order</dt><dd className="mono">{run.payment.orderId}</dd></div>}
          </dl>
        </Panel>

        <Panel index="02" label="AI RISK PLAN" state={planState} expanded={Boolean(expanded.plan)} onToggle={() => toggle('plan')}
          summary={planView ? `${planView.riskLevel} risk · ${planView.scenarios.length} scenarios` : 'Compiling…'}
        >
          {planView && (
            <>
              <dl>
                <div><dt>Risk level (compiled)</dt><dd>{planView.riskLevel}</dd></div>
                <div><dt>Tool budget (compiled)</dt><dd className="mono">{planView.toolBudgetAtomic}</dd></div>
                <div><dt>Scenarios run</dt><dd>{planView.scenarios.join(', ')}</dd></div>
              </dl>
              <p className="ai-rationale">{planView.rationale}</p>
              {planView.aiProposal ? (
                <div className="ai-proposal-diff">
                  <span className="panel-sublabel">AI PROPOSED THIS (ADVISORY, NOT BINDING)</span>
                  <dl>
                    <div><dt>Risk level</dt><dd>{planView.aiProposal.riskLevel}</dd></div>
                    <div><dt>Scenarios</dt><dd>{planView.aiProposal.proposedScenarios.join(', ')}</dd></div>
                    <div><dt>Budget</dt><dd className="mono">{planView.aiProposal.proposedToolBudgetAtomic}</dd></div>
                  </dl>
                </div>
              ) : (
                <p className="ai-rationale">AI proposal not recorded for this run (resumed from an older checkpoint).</p>
              )}
            </>
          )}
        </Panel>

        <Panel index="03" label="EVIDENCE" state={evidenceState} expanded={Boolean(expanded.evidence)} onToggle={() => toggle('evidence')}
          summary={evidence ? evidence.publicManifest.result : 'Building…'}
        >
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
        </Panel>

        <Panel index="04" label="ON-CHAIN ATTESTATION" state={attestationState} expanded={Boolean(expanded.attestation)} onToggle={() => toggle('attestation')}
          summary={attestation ? 'Recorded on-chain' : 'Pending…'}
        >
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
        </Panel>
      </div>
    </>
  );
}

function Panel({
  index,
  label,
  state,
  summary,
  expanded,
  onToggle,
  action,
  children,
}: Readonly<{
  index: string;
  label: string;
  state: PanelState;
  summary: string;
  expanded: boolean;
  onToggle: () => void;
  /** Rendered unconditionally, outside the collapsible body -- for an actual action (like
   * WalletPayPanel) that must stay mounted and visible whether or not the card is expanded.
   * Collapsing the card to save space shouldn't cost it its in-progress payment/tx state, and
   * an action the customer still needs to take shouldn't be hidden behind a click to expand. */
  action?: React.ReactNode;
  children: React.ReactNode;
}>) {
  return (
    <div className={`run-detail-panel glow-card state-in${expanded ? ' is-expanded' : ''}`} data-state={state}>
      <button type="button" className="panel-toggle" onClick={onToggle} aria-expanded={expanded}>
        <span className="panel-label"><i>[{index}]</i> {label}</span>
        <span className="panel-summary">
          {state === 'active' && <RadarMark className="panel-status-icon" />}
          {state === 'ready' && <span className="panel-status-check" aria-hidden="true">✓</span>}
          {state === 'fail' && <span className="panel-status-fail" aria-hidden="true">✕</span>}
          {summary}
        </span>
        <span className="panel-toggle-chevron" aria-hidden="true">+</span>
      </button>
      {action && <div className="panel-action">{action}</div>}
      {expanded && <div className="panel-body state-in">{children}</div>}
    </div>
  );
}
