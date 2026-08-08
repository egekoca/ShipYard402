'use client';

import {
  ShipyardApiClient,
  ShipyardApiError,
  type AttestationResponse,
  type EvidenceResponse,
  type PlanResponse,
  type RunResponse,
  type StepDurationStatsResponse,
} from '@shipyard402/public-api-client';
import { useEffect, useMemo, useState } from 'react';

import { getStoredSessionToken } from '../lib/session';

const POLL_MS = 4000;
const TERMINAL_STATUSES = new Set([
  'DELIVERED_PASS',
  'DELIVERED_CONDITIONAL',
  'DELIVERED_FAIL',
  'DELIVERED_INCONCLUSIVE',
  'CANCELLED',
  'EXPIRED',
]);

export function stepIndexForStatus(status: string): number {
  if (['DRAFT', 'QUOTED', 'PAYMENT_REQUIRED'].includes(status)) return -1;
  // A run that never got paid or was cancelled early never reached step 0, let alone finished --
  // without this it fell through to the same index 5 a genuinely successful DELIVERED_* run gets,
  // showing a false "payment confirmed" checkmark and live spinners on steps that never ran.
  if (status === 'CANCELLED' || status === 'EXPIRED') return -1;
  if (status === 'FUNDED') return 0;
  if (['ANALYZING', 'PLAN_COMPILED'].includes(status)) return 1;
  if (['PROCURING', 'EXECUTING', 'REPLANNING'].includes(status)) return 2;
  if (status === 'EVIDENCE_BUILDING') return 3;
  if (status === 'ATTESTING') return 4;
  return 5;
}

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** Polls a run (plus its evidence/attestation once available) every few seconds, backing off once terminal. */
export function useRunProgress(runId: string | null) {
  const [run, setRun] = useState<RunResponse | null>(null);
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [evidence, setEvidence] = useState<EvidenceResponse | null>(null);
  const [attestation, setAttestation] = useState<AttestationResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastPolledAt, setLastPolledAt] = useState<Date | null>(null);
  const client = useMemo(
    () =>
      new ShipyardApiClient(process.env['NEXT_PUBLIC_SHIPYARD_API_URL'] ?? 'http://127.0.0.1:3001', undefined, () =>
        getStoredSessionToken(),
      ),
    [],
  );

  // run?.run.status (not the whole run object) is deliberate -- poll() only reads `run` to compute
  // the *next* backoff interval, and a fresh effect invocation with an up-to-date closure already
  // fires whenever the status itself changes, so depending on the full object would just restart
  // polling more than needed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above -- narrower dep is intentional
  useEffect(() => {
    if (!runId) {
      setRun(null);
      setPlan(null);
      setEvidence(null);
      setAttestation(null);
      return;
    }
    // Declared fresh per effect invocation (not a component-level ref) -- a ref shared across
    // invocations gets reset to false by the *next* effect's setup before a slow in-flight fetch
    // from *this* invocation resolves, so that stale fetch would pass the guard and clobber the
    // newer run's state with the old run's data. Each invocation must only ever cancel itself.
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      try {
        const [runResponse, planResponse, evidenceResponse, attestationResponse] = await Promise.all([
          client.getRun(runId as string),
          client.getPlan(runId as string),
          client.getEvidence(runId as string),
          client.getAttestation(runId as string),
        ]);
        if (cancelled) return;
        setRun(runResponse);
        setPlan(planResponse);
        setEvidence(evidenceResponse);
        setAttestation(attestationResponse);
        setError(null);
        setLastPolledAt(new Date());
      } catch (caught) {
        if (cancelled) return;
        setError(
          caught instanceof ShipyardApiError
            ? `${caught.code}: ${caught.message}`
            : 'Could not reach the Shipyard402 API',
        );
      }
      if (cancelled) return;
      const isTerminal = run && TERMINAL_STATUSES.has(run.run.status);
      timeout = setTimeout(poll, isTerminal ? POLL_MS * 4 : POLL_MS);
    }

    void poll();
    return () => {
      cancelled = true;
      if (timeout) clearTimeout(timeout);
    };
  }, [runId, client, run?.run.status]);

  const activeStep = run ? stepIndexForStatus(run.run.status) : -1;
  const isTerminal = run ? TERMINAL_STATUSES.has(run.run.status) : false;

  return { run, plan, evidence, attestation, error, lastPolledAt, activeStep, isTerminal };
}

/**
 * Fetches once, not polled -- it's a slow-moving aggregate over recent completed runs, not
 * per-run state. Failing quietly (no ETA hint) beats surfacing an error banner for what is only
 * ever a nice-to-have estimate.
 */
export function useStepDurationStats(): StepDurationStatsResponse | null {
  const [stats, setStats] = useState<StepDurationStatsResponse | null>(null);
  const client = useMemo(
    () =>
      new ShipyardApiClient(process.env['NEXT_PUBLIC_SHIPYARD_API_URL'] ?? 'http://127.0.0.1:3001', undefined, () =>
        getStoredSessionToken(),
      ),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    client
      .getStepDurationStats()
      .then((result) => {
        if (!cancelled) setStats(result);
      })
      .catch(() => {
        /* no ETA hint is a fine fallback */
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  return stats;
}

/** "~3s" / "~2m 15s" -- always rounds to the nearest whole second, never shows milliseconds. */
export function formatDurationEstimate(milliseconds: number): string {
  const totalSeconds = Math.max(1, Math.round(milliseconds / 1000));
  if (totalSeconds < 60) return `~${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `~${minutes}m` : `~${minutes}m ${seconds}s`;
}

export function explorerTxUrl(chainId: number, txHash: string): string {
  const base = chainId === 2345 ? 'https://explorer.goat.network' : 'https://explorer.testnet3.goat.network';
  return `${base}/tx/${txHash}`;
}

export function ipfsGatewayUrl(uri: string): string {
  return uri.startsWith('ipfs://') ? `https://ipfs.io/ipfs/${uri.slice('ipfs://'.length)}` : uri;
}

export function shortHash(value: string): string {
  return `${value.slice(0, 10)}…${value.slice(-6)}`;
}
