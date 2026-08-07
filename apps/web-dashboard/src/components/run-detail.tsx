'use client';

import { ShipyardApiClient } from '@shipyard402/public-api-client';
import { useEffect, useState } from 'react';

import { useRunProgress } from '../hooks/use-run-progress';
import { connectWallet, formatWalletError, getAuthorizedAccount } from '../lib/goat-wallet';
import { ensureSession } from '../lib/session';
import { RunProgressPanels } from './run-progress-panels';
import { SiteHeader } from './site-header';

export function RunDetail({ runId }: Readonly<{ runId: string }>) {
  const { run, plan, evidence, attestation, error, lastPolledAt, activeStep, isTerminal } = useRunProgress(runId);
  // This page is a permalink -- reached by a fresh visit, a bookmark, or a shared link with no
  // prior page state, so unlike release-run-form.tsx it can't assume a session already exists.
  // Every GET this page polls now requires proof the caller owns the run, so it needs its own
  // minimal connect/sign flow rather than relying on one established elsewhere.
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const needsAuth = error?.startsWith('AUTH_') ?? false;

  useEffect(() => {
    let cancelled = false;
    getAuthorizedAccount().then(async (address) => {
      if (cancelled || !address) return;
      const client = new ShipyardApiClient(process.env['NEXT_PUBLIC_SHIPYARD_API_URL'] ?? 'http://127.0.0.1:3001');
      await ensureSession(client, address);
    }).catch(() => { /* no wallet, or the user hasn't authorized this site -- the Connect button below handles it */ });
    return () => { cancelled = true; };
  }, []);

  async function handleConnect() {
    setConnecting(true);
    setConnectError(null);
    try {
      const address = await connectWallet();
      const client = new ShipyardApiClient(process.env['NEXT_PUBLIC_SHIPYARD_API_URL'] ?? 'http://127.0.0.1:3001');
      await ensureSession(client, address);
      // The polling loop already re-attaches whatever token is in storage on its next tick
      // (getStoredSessionToken is read fresh per request), so no explicit refetch is needed here.
    } catch (caught) {
      setConnectError(formatWalletError(caught));
    } finally {
      setConnecting(false);
    }
  }

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
        {needsAuth ? (
          <div className="error-card state-in">
            <strong>Connect the wallet that requested this run</strong>
            <p>This run's progress is only visible to the wallet that requested it.</p>
            <button className="wallet-button" type="button" disabled={connecting} onClick={handleConnect}>
              {connecting && <span className="spinner" aria-hidden="true" />}
              Connect wallet
            </button>
            {connectError && <p>{connectError}</p>}
          </div>
        ) : error && (
          <div className="error-card state-in"><strong>Request blocked</strong><p>{error}</p></div>
        )}
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
