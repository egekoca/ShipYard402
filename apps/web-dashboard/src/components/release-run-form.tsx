'use client';

import {
  ShipyardApiError,
  type QuoteRequest,
  type QuoteResponse,
  type RunResponse,
  type ServiceOnboardingResponse,
} from '@shipyard402/public-api-client';
import type { FormEvent, InputHTMLAttributes } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useRunProgress } from '../hooks/use-run-progress';
import {
  createApiClient,
  DEFAULT_API_BACKEND,
  fundingChainIdForBackend,
  type ApiBackendId,
  type RoutedMarketplaceService,
} from '../lib/api-backends';
import { formatAtomic } from '../lib/amount-format';
import { connectWallet, ensureChain, formatWalletError, getAuthorizedAccount } from '../lib/goat-wallet';
import { ensureSession, getStoredSessionToken } from '../lib/session';
import GlassSurface from './GlassSurface';
import { RunHistory } from './run-history';
import { RunProgressPanels } from './run-progress-panels';
import { ServiceMarketplace } from './service-marketplace';
import { ServiceOnboarding } from './service-onboarding';
import SpotlightCard from './SpotlightCard';
import { VerifiedText } from './verified-text';

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
 * The form starts with no target at all. Every catalog identifier a quote binds against --
 * organization, service, agent, version hash, policy hash, endpoints -- describes a row that
 * exists in some deployment's database, so the only truthful sources for them are the directory
 * and the onboarding form. Compiling a target in here instead would ship identifiers that are
 * only valid against one particular database and an endpoint nobody can reach, and a visitor who
 * funded that would pay for a run whose target does not exist.
 *
 * The directory selects its first listing as soon as it loads, so the common case still lands on
 * a ready-to-quote target without anyone typing a UUID and two 32-byte hashes.
 */
const initialForm: FormState = {
  organizationId: '',
  targetAgentId: '',
  targetServiceId: '',
  targetVersionHash: '',
  policyHash: '',
  x402Endpoint: '',
  openApiUrl: '',
  // The customer's own spending limit, not a property of any service -- safe to prefill.
  maximumCustomerBudgetAtomic: '5000000',
  requesterAddress: '',
};

/** Every identifier the server binds a quote against. A blank one means there is no target yet. */
const TARGET_FIELDS = [
  'organizationId',
  'targetAgentId',
  'targetServiceId',
  'targetVersionHash',
  'policyHash',
  'x402Endpoint',
  'openApiUrl',
] as const satisfies readonly (keyof FormState)[];

function hasCompleteTarget(form: FormState): boolean {
  return TARGET_FIELDS.every((field) => form[field].trim().length > 0);
}

export function ReleaseRunForm() {
  const [form, setForm] = useState<FormState>(initialForm);
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [run, setRun] = useState<RunResponse | null>(null);
  const [runRequestKey, setRunRequestKey] = useState<string | null>(null);
  const [apiBackend, setApiBackend] = useState<ApiBackendId>(DEFAULT_API_BACKEND);
  // The catalog's settlement chain, independent from which API deployment owns the listing.
  // Selecting a card updates this immediately so a later wallet connection still lands on the
  // service's own network rather than a backend-wide default.
  const [selectedChainId, setSelectedChainId] = useState(() => fundingChainIdForBackend(DEFAULT_API_BACKEND));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const runProgressRef = useRef<HTMLElement>(null);
  // Polls the run itself the moment it exists, independently of the WalletPayPanel below --
  // so the pipeline visibly starts moving the instant the payment worker sees the on-chain
  // settlement, without the customer ever having to leave this page to watch it happen.
  const progress = useRunProgress(run?.run.id ?? null, apiBackend);
  // The directory entry currently being targeted, kept only so the summary line can say the
  // service's human name ("GOAT Testnet Paid API") instead of its catalog id. Null means the
  // target came from onboarding rather than a listing, or that there is no target yet.
  const [selectedListing, setSelectedListing] = useState<RoutedMarketplaceService | null>(null);
  // Lifted out of ServiceOnboarding so the directory's "Not listed? Add your API" affordance can
  // open the same panel, rather than there being two separate ways in that don't know about
  // each other.
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  // Collapsed by default: these are catalog identifiers (a UUID, two 32-byte hashes, two URLs)
  // that describe exactly which registered service/version/policy the quote is for -- nobody is
  // meant to type these by hand, selecting a listing or onboarding a service fills them in. Shown
  // collapsed so a first-time visitor sees "what am I testing" in plain language, not a form.
  const [showTechnical, setShowTechnical] = useState(false);
  // No target means nothing to quote. Guarding here rather than letting the request go out keeps
  // the failure honest and local: the server would reject an incomplete binding anyway, but only
  // after the person had reason to think a run was starting.
  const targetReady = hasCompleteTarget(form);
  const client = useMemo(
    () =>
      createApiClient(apiBackend, () =>
        getStoredSessionToken(form.requesterAddress ? (form.requesterAddress as `0x${string}`) : null, apiBackend),
      ),
    [apiBackend, form.requesterAddress],
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

  // Once the economic commitment creates a real run, take the customer directly to step 1.
  // Without this, the payment challenge is rendered below the fold and can look as if clicking
  // Create did nothing, while the payment window is already counting down out of sight.
  const createdRunId = run?.run.id;
  useEffect(() => {
    if (!createdRunId) return;
    runProgressRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, [createdRunId]);

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
        void ensureChain(fundingChainIdForBackend(apiBackend)).catch(() => {
          /* WalletPayPanel retries this later */
        });
        // Best-effort: if this signature is skipped or fails, the first protected API call below
        // (requestQuote/createRun) tries again before it actually needs the token.
        void ensureSession(client, address, apiBackend).catch(() => {});
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
      // Add/switch to this deployment's selected network immediately -- don't wait for a
      // quote+run to exist first, so
      // the wallet is already on the right network well before Pay is ever clicked. A failure
      // here (e.g. the add-network prompt was dismissed) still leaves the address connected;
      // WalletPayPanel retries the same call later.
      try {
        await ensureChain(selectedChainId);
      } catch (chainError) {
        setError(formatWalletError(chainError));
      }
      // One signature to prove control of the address, traded for a bearer token -- everything
      // below this (quoting, creating a run, reading its own progress) needs it.
      await ensureSession(client, address, apiBackend);
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
      await ensureSession(client, form.requesterAddress as `0x${string}`, apiBackend);
      const created = await client.createQuote(form as QuoteRequest);
      setQuote(created);
      setRunRequestKey(`web-${globalThis.crypto.randomUUID()}`);
    } catch (caught) {
      setError(formatError(caught));
    } finally {
      setBusy(false);
    }
  }

  function handleOnboarded(onboarded: ServiceOnboardingResponse, backend: ApiBackendId, chainId: number) {
    setForm((current) => ({
      ...current,
      organizationId: onboarded.organizationId,
      targetServiceId: onboarded.targetServiceId,
      targetAgentId: onboarded.targetAgentId,
      targetVersionHash: onboarded.targetVersionHash,
      policyHash: onboarded.policyHash,
      x402Endpoint: onboarded.x402Endpoint,
      openApiUrl: onboarded.openApiUrl,
    }));
    setApiBackend(backend);
    setSelectedChainId(chainId);
    void ensureChain(chainId).catch((caught: unknown) => setError(formatWalletError(caught)));
    setSelectedListing(null);
    setQuote(null);
    setRun(null);
    setRunRequestKey(null);
    setError(null);
    setShowTechnical(true);
  }

  /**
   * A directory listing already carries every identifier a quote binds against, so selecting one
   * replaces the whole target in a single click. The budget ceiling is deliberately left alone --
   * it is the customer's own spending limit, not a property of the service being tested.
   */
  function handleSelectService(service: RoutedMarketplaceService) {
    setForm((current) => ({
      ...current,
      organizationId: service.organizationId,
      targetServiceId: service.targetServiceId,
      targetAgentId: service.targetAgentId,
      targetVersionHash: service.targetVersionHash,
      policyHash: service.policyHash,
      x402Endpoint: service.x402Endpoint,
      openApiUrl: service.openApiUrl,
    }));
    setApiBackend(service.apiBackend);
    setSelectedChainId(service.chainId);
    if (form.requesterAddress) {
      void ensureChain(service.chainId).catch((caught: unknown) => setError(formatWalletError(caught)));
    }
    setSelectedListing(service);
    setOnboardingOpen(false);
    setQuote(null);
    setRun(null);
    setRunRequestKey(null);
    setError(null);
  }

  async function createRun() {
    if (!quote || !runRequestKey) return;
    setBusy(true);
    setError(null);
    try {
      await ensureSession(client, form.requesterAddress as `0x${string}`, apiBackend);
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
      {form.requesterAddress && (
        <RunHistory requesterAddress={form.requesterAddress as `0x${string}`} apiBackend={apiBackend} />
      )}
      <ServiceMarketplace
        selectedServiceId={form.targetServiceId}
        selectedApiBackend={apiBackend}
        canRegister={Boolean(form.requesterAddress)}
        onSelect={handleSelectService}
        onRegisterOwn={() => setOnboardingOpen(true)}
      />
      <div className="run-grid">
        <SpotlightCard className="app-card-spotlight app-form-spotlight" spotlightColor="rgba(240, 196, 25, 0.12)">
          <form className="release-form" onSubmit={requestQuote}>
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
                  {selectedListing ? (
                    <>
                      Testing <strong>{selectedListing.name}</strong> at release{' '}
                      <span className="mono">{selectedListing.version}</span> — selected from the directory above.
                    </>
                  ) : targetReady ? (
                    <>
                      Testing <strong className="mono">{form.targetServiceId}</strong> — registered through onboarding
                      below.
                    </>
                  ) : (
                    <>
                      No target selected yet — pick a service from the directory above, or register your own through
                      onboarding.
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
                    open={onboardingOpen}
                    onOpenChange={setOnboardingOpen}
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
              <button
                className="primary-button"
                disabled={busy || !form.requesterAddress || !targetReady}
                type="submit"
              >
                {busy && <span className="spinner" aria-hidden="true" />}
                {!form.requesterAddress
                  ? 'Connect a wallet first'
                  : !targetReady
                    ? 'Pick a target first'
                    : busy
                      ? 'Checking capability…'
                      : 'Request transparent quote'}
              </button>
            </div>
          </form>
        </SpotlightCard>

        <SpotlightCard className="app-card-spotlight app-quote-spotlight" spotlightColor="rgba(240, 196, 25, 0.15)">
          <aside className="quote-panel" aria-live="polite">
            <span className="panel-label">ECONOMIC COMMITMENT</span>
            {!quote && !error && (
              <div className="empty-state state-in">
                <div className="radar">
                  <span className="radar-sweep" />
                </div>
                <h3>No fabricated quote</h3>
                <p>
                  A price appears only when the selected backend has a reviewed chain, token, and receiving-address
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
                <GlassSurface
                  width="100%"
                  height={42}
                  borderRadius={10}
                  borderWidth={0.045}
                  brightness={16}
                  opacity={0.78}
                  blur={7}
                  displace={0.15}
                  backgroundOpacity={0.06}
                  saturation={1.12}
                  distortionScale={-55}
                  redOffset={0}
                  greenOffset={0}
                  blueOffset={0}
                  mixBlendMode="normal"
                  className="quote-status quote-status-glass"
                >
                  <span>HYPOTHESIS</span>
                  {!run && quoteExpiresInMs !== null && (
                    <small
                      className={
                        quoteExpiresInMs <= 60_000 ? 'quote-countdown quote-countdown--low' : 'quote-countdown'
                      }
                    >
                      {quoteExpired ? 'expired' : `expires in ${formatCountdown(quoteExpiresInMs)}`}
                    </small>
                  )}
                </GlassSurface>
                <p className="amount">
                  <span className="quote-amount-value">
                    {formatAtomic(quote.totalAtomicAmount, quote.capabilitySnapshot.tokenDecimals)}
                  </span>{' '}
                  <small>{quote.capabilitySnapshot.tokenSymbol}</small>
                </p>
                <dl>
                  <div>
                    <dt>Network</dt>
                    <dd>
                      {networkLabel(quote.capabilitySnapshot.chainId)} / {quote.capabilitySnapshot.chainId}
                    </dd>
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
                    <dd className="mono">
                      <VerifiedText text={shortHash(quote.quoteCommitment)} />
                    </dd>
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
        </SpotlightCard>
      </div>

      {run && (
        <section ref={runProgressRef} className="run-progress-section glow-card" aria-live="polite">
          <div className="run-progress-header">
            <span className="panel-label">
              <i>[RUN]</i> {run.run.id}
              {!progress.isTerminal && <span className="live-pulse" aria-hidden="true" />}
            </span>
            <a
              className="explorer-link"
              href={`/runs/${encodeURIComponent(run.run.id)}?backend=${encodeURIComponent(apiBackend)}`}
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
              apiBackend={apiBackend}
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

export { formatAtomic } from '../lib/amount-format';

function networkLabel(chainId: number): string {
  if (chainId === 968) return 'BOT Chain';
  if (chainId === 56) return 'BNB';
  return 'GOAT';
}
