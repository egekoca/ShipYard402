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

function shortRunId(id: string): string {
  return id.length <= 24 ? id : `${id.slice(0, 16)}…${id.slice(-6)}`;
}

function shortServiceId(id: string): string {
  return id.length <= 34 ? id : `…${id.slice(-31)}`;
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
      <div className="run-history-header">
        <span className="panel-label">YOUR PAST RUNS</span>
        {runs && <span className="run-history-count">{runs.length}</span>}
      </div>
      {!runs ? (
        <p className="run-history-loading">Looking up runs for {requesterAddress.slice(0, 6)}…{requesterAddress.slice(-4)}…</p>
      ) : (
        <div className="run-history-table-wrap">
          <table className="run-history-table">
            <thead>
              <tr>
                <th className="run-history-col-index">#</th>
                <th>Status</th>
                <th>Service</th>
                <th>Run</th>
                <th>Created</th>
                <th className="run-history-col-action" aria-hidden="true" />
              </tr>
            </thead>
            <tbody>
              {runs.map((run, index) => (
                <tr key={run.id} onClick={() => { window.location.href = `/runs/${encodeURIComponent(run.id)}`; }}>
                  <td className="run-history-col-index mono">{index + 1}</td>
                  <td>
                    <span className={`run-history-status run-history-status--${statusTone(run)}`}>{statusLabel(run)}</span>
                  </td>
                  <td className="mono run-history-service" title={run.targetServiceId}>{shortServiceId(run.targetServiceId)}</td>
                  <td className="mono" title={run.id}>{shortRunId(run.id)}</td>
                  <td className="run-history-date">{new Date(run.createdAt).toLocaleString()}</td>
                  <td className="run-history-col-action">
                    <a
                      className="run-history-open"
                      href={`/runs/${encodeURIComponent(run.id)}`}
                      onClick={(event) => event.stopPropagation()}
                    >
                      Open ↗
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
