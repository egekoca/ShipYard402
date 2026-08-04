'use client';

import {
  ShipyardApiClient,
  ShipyardApiError,
  type QuoteRequest,
  type QuoteResponse,
  type RunResponse,
} from '@shipyard402/public-api-client';
import type { FormEvent, InputHTMLAttributes } from 'react';
import { useMemo, useState } from 'react';

type FormState = Readonly<{
  organizationId: string;
  requesterAddress: string;
  targetAgentId: string;
  targetServiceId: string;
  targetVersionHash: string;
  policyHash: string;
  x402Endpoint: string;
  openApiUrl: string;
  maximumCustomerBudgetAtomic: string;
}>;

const initialForm: FormState = {
  organizationId: '',
  requesterAddress: '',
  targetAgentId: '',
  targetServiceId: '',
  targetVersionHash: '',
  policyHash: '',
  x402Endpoint: '',
  openApiUrl: '',
  maximumCustomerBudgetAtomic: '',
};

export function ReleaseRunForm() {
  const [form, setForm] = useState<FormState>(initialForm);
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [run, setRun] = useState<RunResponse | null>(null);
  const [runRequestKey, setRunRequestKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const client = useMemo(
    () => new ShipyardApiClient(process.env['NEXT_PUBLIC_SHIPYARD_API_URL'] ?? 'http://127.0.0.1:3001'),
    [],
  );

  function update(field: keyof FormState, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
    setQuote(null);
    setRun(null);
    setRunRequestKey(null);
    setError(null);
  }

  async function requestQuote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setQuote(null);
    setRun(null);
    setRunRequestKey(null);
    try {
      const created = await client.createQuote(form as QuoteRequest);
      setQuote(created);
      setRunRequestKey(`web-${globalThis.crypto.randomUUID()}`);
    } catch (caught) {
      setError(formatError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function createRun() {
    if (!quote || !runRequestKey) return;
    setBusy(true);
    setError(null);
    try {
      const created = await client.createRun(quote.id, runRequestKey);
      setRun(await client.requestPaymentChallenge(created.run.id));
    } catch (caught) {
      setError(formatError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="run-grid">
      <form className="release-form" onSubmit={requestQuote}>
        <Field label="Organization ID" value={form.organizationId} onChange={(value) => update('organizationId', value)} placeholder="UUID from onboarding" />
        <Field label="Requester wallet" value={form.requesterAddress} onChange={(value) => update('requesterAddress', value)} placeholder="0x…" />
        <Field label="Target agent ID" value={form.targetAgentId} onChange={(value) => update('targetAgentId', value)} placeholder="ERC-8004 ID or external identity" />
        <Field label="Target service ID" value={form.targetServiceId} onChange={(value) => update('targetServiceId', value)} placeholder="Registered service ID" />
        <Field label="Version hash" value={form.targetVersionHash} onChange={(value) => update('targetVersionHash', value)} placeholder="0x + 32 bytes" />
        <Field label="Policy hash" value={form.policyHash} onChange={(value) => update('policyHash', value)} placeholder="0x + 32 bytes" />
        <Field label="Paid x402 endpoint" value={form.x402Endpoint} onChange={(value) => update('x402Endpoint', value)} placeholder="https://service.example/paid" type="url" />
        <Field label="OpenAPI document" value={form.openApiUrl} onChange={(value) => update('openApiUrl', value)} placeholder="https://service.example/openapi.json" type="url" />
        <Field label="Maximum budget (atomic units)" value={form.maximumCustomerBudgetAtomic} onChange={(value) => update('maximumCustomerBudgetAtomic', value)} placeholder="Token-specific atomic amount" inputMode="numeric" />
        <button className="primary-button" disabled={busy} type="submit">
          {busy && <span className="spinner" aria-hidden="true" />}
          {busy ? 'Checking capability…' : 'Request transparent quote'}
        </button>
      </form>

      <aside className="quote-panel" aria-live="polite">
        <span className="panel-label">ECONOMIC COMMITMENT</span>
        {!quote && !error && (
          <div className="empty-state state-in">
            <div className="radar"><span className="radar-sweep" /></div>
            <h3>No fabricated quote</h3>
            <p>A price appears only when the backend has a reviewed GOAT Flow chain, token, and receiving-address capability.</p>
          </div>
        )}
        {error && (
          <div className="error-card state-in" key={error}>
            <strong>Request blocked</strong>
            <p>{error}</p>
          </div>
        )}
        {quote && (
          <div className="quote-result state-in" key={quote.id}>
            <div className="quote-status"><span>HYPOTHESIS</span><small>expires {new Date(quote.expiresAt).toLocaleTimeString()}</small></div>
            <p className="amount">{formatAtomic(quote.totalAtomicAmount, quote.capabilitySnapshot.tokenDecimals)} <small>{quote.capabilitySnapshot.tokenSymbol}</small></p>
            <dl>
              <div><dt>Network</dt><dd>GOAT / {quote.capabilitySnapshot.chainId}</dd></div>
              <div><dt>Mode</dt><dd>{quote.capabilitySnapshot.mode}</dd></div>
              <div><dt>Refundable tool budget</dt><dd>{quote.refundableToolBudgetAtomic}</dd></div>
              <div><dt>Commitment</dt><dd className="mono">{shortHash(quote.quoteCommitment)}</dd></div>
            </dl>
            <button className="primary-button" type="button" disabled={busy || Boolean(run)} onClick={createRun}>
              {busy && <span className="spinner" aria-hidden="true" />}
              {run ? `Run ${run.run.status}` : 'Create idempotent run'}
            </button>
            {run && (
              <div className="run-created state-in">
                <strong>{run.run.id}</strong>
                <span>{run.payment.nextAction}</span>
                {run.payment.orderId && <span>GOAT Flow order: {run.payment.orderId}</span>}
              </div>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}

function Field({ label, onChange, value, ...input }: Readonly<{ label: string; onChange: (value: string) => void; value: string } & Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'>>) {
  return (
    <label className="field">
      <span>{label}</span>
      <input {...input} required value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function formatError(error: unknown): string {
  if (error instanceof ShipyardApiError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : 'Unexpected request failure';
}

function shortHash(value: string): string {
  return `${value.slice(0, 12)}…${value.slice(-8)}`;
}

function formatAtomic(value: string, decimals: number): string {
  if (decimals === 0) return value;
  const divisor = 10n ** BigInt(decimals);
  return `${BigInt(value) / divisor}.${(BigInt(value) % divisor).toString().padStart(decimals, '0')}`;
}
