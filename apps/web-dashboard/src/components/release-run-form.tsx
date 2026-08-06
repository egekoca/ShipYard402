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

import { useRunProgress } from '../hooks/use-run-progress';
import { connectWallet, ensureChain, formatWalletError, GOAT_TESTNET3_CHAIN_ID } from '../lib/goat-wallet';
import { RunProgressPanels } from './run-progress-panels';

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

/**
 * The one service/release/policy currently onboarded in the catalog (organizations/services/
 * releases/policies tables) that a quote can actually be created against -- there is no
 * self-service onboarding flow yet (a real one would let a customer register their own service
 * and compute these from their live OpenAPI spec), so asking a person to hand-type a UUID and two
 * 32-byte hashes here would be pure friction for zero benefit until that exists. Pre-filling the
 * one target that's actually real removes that friction without pretending it's more dynamic than
 * it is; the fields stay editable for anyone who has their own onboarded catalog entry to test.
 */
const SELF_TEST_TARGET: Omit<FormState, 'requesterAddress'> = {
  organizationId: 'b6b9ef3b-5528-4dd6-b3e7-cb79440db30a',
  targetAgentId: 'agent:shipyard402-selftest',
  targetServiceId: 'service:x402-demo-target:testnet3-real-merchant',
  targetVersionHash: '0xd7a58f3393a3ce108484d3fe83c2a65a870c99cb1be072363b9cc26f1f5ec176',
  policyHash: '0x46a763af460addd917b0bb04976aee3544dbfe1e5d8cfe89808247091351c490',
  x402Endpoint: 'https://x402-demo-target.shipyard402-selftest.internal/paid/resource',
  openApiUrl: 'https://x402-demo-target.shipyard402-selftest.internal/openapi.json',
  maximumCustomerBudgetAtomic: '5000000',
};

const initialForm: FormState = {
  ...SELF_TEST_TARGET,
  requesterAddress: '',
};

export function ReleaseRunForm() {
  const [form, setForm] = useState<FormState>(initialForm);
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [run, setRun] = useState<RunResponse | null>(null);
  const [runRequestKey, setRunRequestKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Polls the run itself the moment it exists, independently of the WalletPayPanel below --
  // so the pipeline visibly starts moving the instant the payment worker sees the on-chain
  // settlement, without the customer ever having to leave this page to watch it happen.
  const progress = useRunProgress(run?.run.id ?? null);
  // Collapsed by default: these are catalog identifiers (a UUID, two 32-byte hashes, two URLs)
  // that describe exactly which pre-registered service/version/policy the quote is for -- nobody
  // is meant to type these by hand, they're already filled in from SELF_TEST_TARGET. Shown
  // collapsed so a first-time visitor sees "what am I testing" in plain language, not a form.
  const [showTechnical, setShowTechnical] = useState(false);
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

  async function handleConnectWallet() {
    setBusy(true);
    setError(null);
    try {
      const address = await connectWallet();
      update('requesterAddress', address);
      // Add/switch to GOAT Testnet3 immediately -- don't wait for a quote+run to exist first, so
      // the wallet is already on the right network well before Pay is ever clicked. A failure
      // here (e.g. the add-network prompt was dismissed) still leaves the address connected;
      // WalletPayPanel retries the same call later.
      try {
        await ensureChain(GOAT_TESTNET3_CHAIN_ID);
      } catch (chainError) {
        setError(formatWalletError(chainError));
      }
    } catch (caught) {
      setError(formatWalletError(caught));
    } finally {
      setBusy(false);
    }
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
    <div className="run-request">
      <div className="run-grid">
        <form className="release-form glow-card" onSubmit={requestQuote}>
          <div className="form-header">
            <span className="form-header-label">Requester</span>
            {form.requesterAddress ? (
              <div className="wallet-connected">
                <span className="live-pulse" aria-hidden="true" />
                <span className="mono">{form.requesterAddress.slice(0, 6)}…{form.requesterAddress.slice(-4)}</span>
              </div>
            ) : (
              <button className="wallet-button" type="button" disabled={busy} onClick={handleConnectWallet}>
                {busy && <span className="spinner" aria-hidden="true" />}
                Connect wallet
              </button>
            )}
          </div>
          <div className="form-body">
            <div className="target-summary">
              <p>
                Testing <strong>x402-demo-target</strong> — a pre-registered, real GOAT Flow merchant
                service on GOAT Testnet3. Budget ceiling: <span className="mono">{form.maximumCustomerBudgetAtomic}</span> atomic units.
              </p>
              <button type="button" className="link-toggle" onClick={() => setShowTechnical((current) => !current)}>
                {showTechnical ? 'Hide' : 'Show'} technical identifiers
              </button>
            </div>
            {showTechnical && (
              <div className="technical-fields">
                <Field label="Organization ID" value={form.organizationId} onChange={(value) => update('organizationId', value)} placeholder="UUID from onboarding" />
                <Field label="Target agent ID" value={form.targetAgentId} onChange={(value) => update('targetAgentId', value)} placeholder="ERC-8004 ID or external identity" />
                <Field label="Target service ID" value={form.targetServiceId} onChange={(value) => update('targetServiceId', value)} placeholder="Registered service ID" />
                <Field label="Version hash" value={form.targetVersionHash} onChange={(value) => update('targetVersionHash', value)} placeholder="0x + 32 bytes" />
                <Field label="Policy hash" value={form.policyHash} onChange={(value) => update('policyHash', value)} placeholder="0x + 32 bytes" />
                <Field label="Paid x402 endpoint" value={form.x402Endpoint} onChange={(value) => update('x402Endpoint', value)} placeholder="https://service.example/paid" type="url" />
                <Field label="OpenAPI document" value={form.openApiUrl} onChange={(value) => update('openApiUrl', value)} placeholder="https://service.example/openapi.json" type="url" />
                <Field label="Maximum budget (atomic units)" value={form.maximumCustomerBudgetAtomic} onChange={(value) => update('maximumCustomerBudgetAtomic', value)} placeholder="Token-specific atomic amount" inputMode="numeric" />
              </div>
            )}
          </div>
          <div className="form-footer">
            <button className="primary-button" disabled={busy || !form.requesterAddress} type="submit">
              {busy && <span className="spinner" aria-hidden="true" />}
              {!form.requesterAddress ? 'Connect a wallet first' : busy ? 'Checking capability…' : 'Request transparent quote'}
            </button>
          </div>
        </form>

        <aside className="quote-panel glow-card" aria-live="polite">
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
                {run ? `Run ${progress.run?.run.status ?? run.run.status}` : 'Create idempotent run'}
              </button>
            </div>
          )}
        </aside>
      </div>

      {run && (
        <section className="run-progress-section glow-card" aria-live="polite">
          <div className="run-progress-header">
            <span className="panel-label">
              <i>[RUN]</i> {run.run.id}
              {!progress.isTerminal && <span className="live-pulse" aria-hidden="true" />}
            </span>
            <a className="explorer-link" href={`/runs/${encodeURIComponent(run.run.id)}`} target="_blank" rel="noreferrer">
              Open standalone page ↗
            </a>
          </div>
          {progress.run ? (
            <RunProgressPanels
              runId={run.run.id}
              run={progress.run}
              evidence={progress.evidence}
              attestation={progress.attestation}
              activeStep={progress.activeStep}
              isTerminal={progress.isTerminal}
              tokenSymbol={quote?.capabilitySnapshot.tokenSymbol}
              tokenDecimals={quote?.capabilitySnapshot.tokenDecimals}
              connectedAddress={form.requesterAddress as `0x${string}`}
            />
          ) : (
            <div className="run-detail-loading">
              <div className="radar"><span className="radar-sweep" /></div>
              <p>Looking up run…</p>
            </div>
          )}
        </section>
      )}
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
