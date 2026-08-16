'use client';

import { type ShipyardApiClient, ShipyardApiError, type RunSummaryResponse } from '@shipyard402/public-api-client';
import { useEffect, useState } from 'react';

import { ensureSession, getStoredSessionToken } from '../lib/session';
import { createApiClient, DEFAULT_API_BACKEND, type ApiBackendId } from '../lib/api-backends';

const API_PAGE_SIZE = 20;
const RUNS_PER_PAGE = 5;

function apiClient(requesterAddress: `0x${string}`, apiBackend: ApiBackendId): ShipyardApiClient {
  return createApiClient(apiBackend, () => getStoredSessionToken(requesterAddress, apiBackend));
}

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

export function RunHistory({
  requesterAddress,
  apiBackend = DEFAULT_API_BACKEND,
}: Readonly<{ requesterAddress: `0x${string}`; apiBackend?: ApiBackendId }>) {
  const [runs, setRuns] = useState<readonly RunSummaryResponse[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  const [loadingPage, setLoadingPage] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRuns(null);
    setHasMore(false);
    setPageIndex(0);
    setError(null);
    const client = apiClient(requesterAddress, apiBackend);
    ensureSession(client, requesterAddress, apiBackend)
      .then(() => client.listRuns(requesterAddress, { limit: API_PAGE_SIZE }))
      .then((page) => {
        if (cancelled) return;
        setRuns(page.runs);
        setHasMore(page.hasMore);
      })
      .catch((caught) => {
        if (cancelled) return;
        setError(
          caught instanceof ShipyardApiError ? `${caught.code}: ${caught.message}` : 'Could not load your past runs',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [requesterAddress, apiBackend]);

  async function showNextPage() {
    if (!runs) return;
    const nextPageIndex = pageIndex + 1;
    if (nextPageIndex * RUNS_PER_PAGE < runs.length) {
      setPageIndex(nextPageIndex);
      return;
    }
    if (!hasMore) return;

    setLoadingPage(true);
    try {
      const client = apiClient(requesterAddress, apiBackend);
      await ensureSession(client, requesterAddress, apiBackend);
      const page = await client.listRuns(requesterAddress, { limit: API_PAGE_SIZE, offset: runs.length });
      const combinedRuns = [...runs, ...page.runs];
      setRuns(combinedRuns);
      setHasMore(page.hasMore);
      if (nextPageIndex * RUNS_PER_PAGE < combinedRuns.length) setPageIndex(nextPageIndex);
    } catch (caught) {
      setError(caught instanceof ShipyardApiError ? `${caught.code}: ${caught.message}` : 'Could not load more runs');
    } finally {
      setLoadingPage(false);
    }
  }

  if (error) return null;
  if (runs && runs.length === 0) return null;

  const loadedPageCount = runs ? Math.ceil(runs.length / RUNS_PER_PAGE) : 0;
  const firstVisibleIndex = pageIndex * RUNS_PER_PAGE;
  const visibleRuns = runs?.slice(firstVisibleIndex, firstVisibleIndex + RUNS_PER_PAGE) ?? [];
  const canShowNextPage = Boolean(runs && (firstVisibleIndex + RUNS_PER_PAGE < runs.length || hasMore));

  return (
    <section className="run-history glow-card state-in" aria-label="Your past runs">
      <div className="run-history-header">
        <span className="panel-label">YOUR PAST RUNS</span>
        {runs && (
          <span className="run-history-count">
            {runs.length}
            {hasMore ? '+' : ''}
          </span>
        )}
      </div>
      {!runs ? (
        <p className="run-history-loading">
          Looking up runs for {requesterAddress.slice(0, 6)}…{requesterAddress.slice(-4)}…
        </p>
      ) : (
        <>
          <div className="run-history-table-wrap">
            <table className="run-history-table">
              <thead>
                <tr>
                  <th className="run-history-col-index">#</th>
                  <th>Status</th>
                  <th>Service</th>
                  <th>Run</th>
                  <th>Created</th>
                  {/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: a <th> has no default tabindex and isn't focusable; this hides an empty header cell from being announced as a blank column heading */}
                  <th className="run-history-col-action" aria-hidden="true" />
                </tr>
              </thead>
              <tbody>
                {visibleRuns.map((run, index) => (
                  <tr
                    key={run.id}
                    onClick={() => {
                      window.location.href = `/runs/${encodeURIComponent(run.id)}?backend=${encodeURIComponent(apiBackend)}`;
                    }}
                  >
                    <td className="run-history-col-index mono">{firstVisibleIndex + index + 1}</td>
                    <td>
                      <span className={`run-history-status run-history-status--${statusTone(run)}`}>
                        {statusLabel(run)}
                      </span>
                    </td>
                    <td className="mono run-history-service" title={run.targetServiceId}>
                      {shortServiceId(run.targetServiceId)}
                    </td>
                    <td className="mono" title={run.id}>
                      {shortRunId(run.id)}
                    </td>
                    <td className="run-history-date">{new Date(run.createdAt).toLocaleString()}</td>
                    <td className="run-history-col-action">
                      <a
                        className="run-history-open"
                        href={`/runs/${encodeURIComponent(run.id)}?backend=${encodeURIComponent(apiBackend)}`}
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
          <nav className="run-history-pagination" aria-label="Past runs pagination">
            <button
              type="button"
              className="run-history-page-nav"
              disabled={pageIndex === 0 || loadingPage}
              onClick={() => setPageIndex((current) => Math.max(0, current - 1))}
              aria-label="Previous page"
            >
              ← Prev
            </button>
            <div className="run-history-page-list">
              {Array.from({ length: loadedPageCount }, (_, index) => index + 1).map((pageNumber) => (
                <button
                  type="button"
                  className={
                    pageNumber === pageIndex + 1
                      ? 'run-history-page-number run-history-page-number--active'
                      : 'run-history-page-number'
                  }
                  key={pageNumber}
                  onClick={() => setPageIndex(pageNumber - 1)}
                  aria-label={`Page ${pageNumber}`}
                  aria-current={pageNumber === pageIndex + 1 ? 'page' : undefined}
                >
                  {pageNumber}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="run-history-page-nav"
              disabled={!canShowNextPage || loadingPage}
              onClick={() => void showNextPage()}
              aria-label="Next page"
            >
              {loadingPage && <span className="spinner" aria-hidden="true" />}
              {loadingPage ? 'Loading…' : 'Next →'}
            </button>
          </nav>
        </>
      )}
    </section>
  );
}
