'use client';

import {
  ShipyardApiClient,
  ShipyardApiError,
  type AttestationResponse,
  type EvidenceResponse,
  type PlanResponse,
  type RunResponse,
} from '@shipyard402/public-api-client';
import { useEffect, useMemo, useRef, useState } from 'react';

const POLL_MS = 4000;
const TERMINAL_STATUSES = new Set([
  'DELIVERED_PASS', 'DELIVERED_CONDITIONAL', 'DELIVERED_FAIL', 'DELIVERED_INCONCLUSIVE', 'CANCELLED', 'EXPIRED',
]);

export function stepIndexForStatus(status: string): number {
  if (['DRAFT', 'QUOTED', 'PAYMENT_REQUIRED'].includes(status)) return -1;
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
    () => new ShipyardApiClient(process.env['NEXT_PUBLIC_SHIPYARD_API_URL'] ?? 'http://127.0.0.1:3001'),
    [],
  );
  const stopped = useRef(false);

  useEffect(() => {
    if (!runId) {
      setRun(null);
      setPlan(null);
      setEvidence(null);
      setAttestation(null);
      return;
    }
    stopped.current = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      try {
        const [runResponse, planResponse, evidenceResponse, attestationResponse] = await Promise.all([
          client.getRun(runId as string),
          client.getPlan(runId as string),
          client.getEvidence(runId as string),
          client.getAttestation(runId as string),
        ]);
        if (stopped.current) return;
        setRun(runResponse);
        setPlan(planResponse);
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

  return { run, plan, evidence, attestation, error, lastPolledAt, activeStep, isTerminal };
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
