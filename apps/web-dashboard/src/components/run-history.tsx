'use client';

import { ShipyardApiClient, ShipyardApiError, type RunSummaryResponse } from '@shipyard402/public-api-client';
import { useEffect, useState } from 'react';

/** Every run's own detail page already renders the exact same status/verdict language -- this
 * only needs to be legible enough to pick the right row to click into. */
function statusLabel(run: RunSummaryResponse): string {
  if (run.result) return run.result;
  if (['CANCELLED', 'EXPIRED'].includes(run.status)) return run.status;
  return run.status.replace(/_/g, ' ');
}

function statusTone(run: RunSummaryResponse): 'pass' | 'fail' | 'pending' {
  if (run.result === 'PASS' || run.result === 'CONDITIONAL') return 'pass';
  if (run.result === 'FAIL' || run.status === 'CANCELLED' || run.status === 'EXPIRED') return 'fail';
  return 'pending';
}

export function RunHistory({ requesterAddress }: Readonly<{ requesterAddress: `0x${string}` }>) {
  const [runs, setRuns] = useState<readonly RunSummaryResponse[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const client = new ShipyardApiClient(process.env['NEXT_PUBLIC_SHIPYARD_API_URL'] ?? 'http://127.0.0.1:3001');
    client.listRuns(requesterAddress)
      .then((result) => { if (!cancelled) setRuns(result); })
      .catch((caught) => {
        if (cancelled) return;
        setError(caught instanceof ShipyardApiError ? `${caught.code}: ${caught.message}` : 'Could not load your past runs');
      });
    return () => { cancelled = true; };
  }, [requesterAddress]);

  if (error) return null;
  if (runs && runs.length === 0) return null;

  return (
    <section className="run-history glow-card state-in" aria-label="Your past runs">
      <span className="panel-label">YOUR PAST RUNS</span>
      {!runs ? (
        <p className="run-history-loading">Looking up runs for {requesterAddress.slice(0, 6)}…{requesterAddress.slice(-4)}…</p>
      ) : (
        <ul className="run-history-list">
          {runs.map((run) => (
            <li key={run.id}>
              <a className="run-history-row" href={`/runs/${encodeURIComponent(run.id)}`}>
                <span className={`run-history-status run-history-status--${statusTone(run)}`}>{statusLabel(run)}</span>
                <span className="run-history-service mono">{run.targetServiceId}</span>
                <span className="run-history-id mono">{run.id}</span>
                <span className="run-history-date">{new Date(run.createdAt).toLocaleString()}</span>
                <span className="run-history-arrow" aria-hidden="true">→</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
