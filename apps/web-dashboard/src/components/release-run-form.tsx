'use client';

import {
  ShipyardApiClient,
  ShipyardApiError,
  type QuoteRequest,
  type QuoteResponse,
  type RunResponse,
  type ServiceOnboardingResponse,
} from '@shipyard402/public-api-client';
import type { FormEvent, InputHTMLAttributes } from 'react';
import { useEffect, useMemo, useState } from 'react';

import { useRunProgress } from '../hooks/use-run-progress';
import {
  connectWallet,
  ensureChain,
  formatWalletError,
  getAuthorizedAccount,
  GOAT_TESTNET3_CHAIN_ID,
} from '../lib/goat-wallet';
import { ensureSession, getStoredSessionToken } from '../lib/session';
import { RunHistory } from './run-history';
import { RunProgressPanels } from './run-progress-panels';
import { ServiceOnboarding } from './service-onboarding';

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
    () =>
      new ShipyardApiClient(process.env['NEXT_PUBLIC_SHIPYARD_API_URL'] ?? 'http://127.0.0.1:3001', undefined, () =>
        getStoredSessionToken(form.requesterAddress ? (form.requesterAddress as `0x${string}`) : null),
      ),
    [form.requesterAddress],
  );

  // Ticks once a second only while a live, unspent quote exists -- a quote has a real 900s
  // expiry (packages/quote-engine), and the only signal of that used to be a static clock-time
  // string. A person who steps away mid-flow deserves visible warning, not a surprise error the
  // moment they come back and click Create.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!quote || run) return;
    const interval = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [quote, run]);
  const quoteExpiresInMs = quote ? Date.parse(quote.expiresAt) - nowMs : null;
  const quoteExpired = quoteExpiresInMs !== null && quoteExpiresInMs <= 0;

  // Restores the connected address after a full page navigation (e.g. back from a run's detail
  // page): the wallet extension's own permission grant survives navigation even though this
  // component's state doesn't, so without this a customer looks disconnected every time they
  // return here despite never actually having disconnected anything. Intentionally mount-only --
  // client is recreated whenever requesterAddress changes, so depending on it would re-run this
  // restore effect right after it just set that same address, which is pointless at best.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above -- mount-only by design
  useEffect(() => {
    let cancelled = false;
    getAuthorizedAccount()
      .then((address) => {
        if (cancelled || !address) return;
        setForm((current) => ({ ...current, requesterAddress: address }));
        void ensureChain(GOAT_TESTNET3_CHAIN_ID).catch(() => {
          /* WalletPayPanel retries this later */
        });
        // Best-effort: if this signature is skipped or fails, the first protected API call below
        // (requestQuote/createRun) tries again before it actually needs the token.
        void ensureSession(client, address).catch(() => {});
      })
      .catch(() => {
        /* no wallet, or the user hasn't authorized this site -- fine, show Connect */
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
      // One signature to prove control of the address, traded for a bearer token -- everything
      // below this (quoting, creating a run, reading its own progress) needs it.
      await ensureSession(client, address);
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
      await ensureSession(client, form.requesterAddress as `0x${string}`);
      const created = await client.createQuote(form as QuoteRequest);
      setQuote(created);
      setRunRequestKey(`web-${globalThis.crypto.randomUUID()}`);
    } catch (caught) {
      setError(formatError(caught));
    } finally {
      setBusy(false);
    }
  }

  function handleOnboarded(onboarded: ServiceOnboardingResponse) {
    setForm((current) => ({
      ...current,
      organizationId: onboarded.organizationId,
      targetServiceId: onboarded.targetServiceId,
      targetVersionHash: onboarded.targetVersionHash,
      policyHash: onboarded.policyHash,
      x402Endpoint: onboarded.x402Endpoint,
      openApiUrl: onboarded.openApiUrl,
    }));
    setQuote(null);
    setRun(null);
    setRunRequestKey(null);
    setError(null);
    setShowTechnical(true);
  }

  async function createRun() {
    if (!quote || !runRequestKey) return;
    setBusy(true);
    setError(null);
    try {
      await ensureSession(client, form.requesterAddress as `0x${string}`);
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
      {form.requesterAddress && <RunHistory requesterAddress={form.requesterAddress as `0x${string}`} />}
      <div className="run-grid">
        <form className="release-form glow-card" onSubmit={requestQuote}>
          <div className="form-header">
            <span className="form-header-label">Requester</span>
            {form.requesterAddress ? (
              <div className="wallet-connected">
                <span className="live-pulse" aria-hidden="true" />
                <span className="mono">
                  {form.requesterAddress.slice(0, 6)}…{form.requesterAddress.slice(-4)}
                </span>
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
                {form.targetServiceId === SELF_TEST_TARGET.targetServiceId ? (
                  <>
                    Testing <strong>x402-demo-target</strong> — a pre-registered, real GOAT Flow merchant service on
                    GOAT Testnet3.
                  </>
                ) : (
                  <>
                    Testing <strong className="mono">{form.targetServiceId}</strong> — registered through onboarding
                    below.
                  </>
                )}{' '}
                Budget ceiling: <span className="mono">{form.maximumCustomerBudgetAtomic}</span> atomic units.
              </p>
              <button type="button" className="link-toggle" onClick={() => setShowTechnical((current) => !current)}>
                {showTechnical ? 'Hide' : 'Show'} technical identifiers
              </button>
              {form.requesterAddress && (
                <ServiceOnboarding
                  requesterAddress={form.requesterAddress as `0x${string}`}
                  onOnboarded={handleOnboarded}
                />
              )}
            </div>
            {showTechnical && (
              <div className="technical-fields">
                <Field
                  label="Organization ID"
                  value={form.organizationId}
                  onChange={(value) => update('organizationId', value)}
                  placeholder="UUID from onboarding"
                />
                <Field
                  label="Target agent ID"
                  value={form.targetAgentId}
                  onChange={(value) => update('targetAgentId', value)}
                  placeholder="ERC-8004 ID or external identity"
                />
                <Field
                  label="Target service ID"
                  value={form.targetServiceId}
                  onChange={(value) => update('targetServiceId', value)}
                  placeholder="Registered service ID"
                />
                <Field
                  label="Version hash"
                  value={form.targetVersionHash}
                  onChange={(value) => update('targetVersionHash', value)}
                  placeholder="0x + 32 bytes"
                />
                <Field
                  label="Policy hash"
                  value={form.policyHash}
                  onChange={(value) => update('policyHash', value)}
                  placeholder="0x + 32 bytes"
                />
                <Field
                  label="Paid x402 endpoint"
                  value={form.x402Endpoint}
                  onChange={(value) => update('x402Endpoint', value)}
                  placeholder="https://service.example/paid"
                  type="url"
                />
                <Field
                  label="OpenAPI document"
                  value={form.openApiUrl}
                  onChange={(value) => update('openApiUrl', value)}
                  placeholder="https://service.example/openapi.json"
                  type="url"
                />
                <Field
                  label="Maximum budget (atomic units)"
                  value={form.maximumCustomerBudgetAtomic}
                  onChange={(value) => update('maximumCustomerBudgetAtomic', value)}
                  placeholder="Token-specific atomic amount"
                  inputMode="numeric"
                />
              </div>
            )}
          </div>
          <div className="form-footer">
            <button className="primary-button" disabled={busy || !form.requesterAddress} type="submit">
              {busy && <span className="spinner" aria-hidden="true" />}
              {!form.requesterAddress
                ? 'Connect a wallet first'
                : busy
                  ? 'Checking capability…'
                  : 'Request transparent quote'}
            </button>
          </div>
        </form>

        <aside className="quote-panel glow-card" aria-live="polite">
          <span className="panel-label">ECONOMIC COMMITMENT</span>
          {!quote && !error && (
            <div className="empty-state state-in">
              <div className="radar">
                <span className="radar-sweep" />
              </div>
              <h3>No fabricated quote</h3>
              <p>
                A price appears only when the backend has a reviewed GOAT Flow chain, token, and receiving-address
                capability.
              </p>
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
              <div className="quote-status">
                <span>HYPOTHESIS</span>
                {!run && quoteExpiresInMs !== null && (
                  <small
                    className={quoteExpiresInMs <= 60_000 ? 'quote-countdown quote-countdown--low' : 'quote-countdown'}
                  >
                    {quoteExpired ? 'expired' : `expires in ${formatCountdown(quoteExpiresInMs)}`}
                  </small>
                )}
              </div>
              <p className="amount">
                {formatAtomic(quote.totalAtomicAmount, quote.capabilitySnapshot.tokenDecimals)}{' '}
                <small>{quote.capabilitySnapshot.tokenSymbol}</small>
              </p>
              <dl>
                <div>
                  <dt>Network</dt>
                  <dd>GOAT / {quote.capabilitySnapshot.chainId}</dd>
                </div>
                <div>
                  <dt>Mode</dt>
                  <dd>{quote.capabilitySnapshot.mode}</dd>
                </div>
                <div>
                  <dt>Refundable tool budget</dt>
                  <dd>{quote.refundableToolBudgetAtomic}</dd>
                </div>
                <div>
                  <dt>Commitment</dt>
                  <dd className="mono">{shortHash(quote.quoteCommitment)}</dd>
                </div>
              </dl>
              {quoteExpired && !run ? (
                <div className="quote-expired-notice">
                  <p>This quote expired before a run was created. Request a fresh one to continue.</p>
                  <button className="primary-button" type="button" onClick={() => setQuote(null)}>
                    Request a new quote
                  </button>
                </div>
              ) : (
                <button className="primary-button" type="button" disabled={busy || Boolean(run)} onClick={createRun}>
                  {busy && <span className="spinner" aria-hidden="true" />}
                  {run ? `Run ${progress.run?.run.status ?? run.run.status}` : 'Create idempotent run'}
                </button>
              )}
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
            <a
              className="explorer-link"
              href={`/runs/${encodeURIComponent(run.run.id)}`}
              target="_blank"
              rel="noreferrer"
            >
              Open standalone page ↗
            </a>
          </div>
          {progress.run ? (
            <RunProgressPanels
              runId={run.run.id}
              run={progress.run}
              plan={progress.plan}
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
              <div className="radar">
                <span className="radar-sweep" />
              </div>
              <p>Looking up run…</p>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function Field({
  label,
  onChange,
  value,
  ...input
}: Readonly<
  { label: string; onChange: (value: string) => void; value: string } & Omit<
    InputHTMLAttributes<HTMLInputElement>,
    'onChange' | 'value'
  >
>) {
  return (
    <label className="field">
      <span>{label}</span>
      <input {...input} required value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

export function formatError(error: unknown): string {
  if (error instanceof ShipyardApiError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : 'Unexpected request failure';
}

export function shortHash(value: string): string {
  return `${value.slice(0, 12)}…${value.slice(-8)}`;
}

export function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function formatAtomic(value: string, decimals: number): string {
  if (decimals === 0) return value;
  const divisor = 10n ** BigInt(decimals);
  return `${BigInt(value) / divisor}.${(BigInt(value) % divisor).toString().padStart(decimals, '0')}`;
}
