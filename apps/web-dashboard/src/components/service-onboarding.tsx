'use client';

import { ShipyardApiError, type ServiceOnboardingResponse } from '@shipyard402/public-api-client';
import { useState } from 'react';

import { backendForChainId, createApiClient, type ApiBackendId } from '../lib/api-backends';
import { ensureSession, getStoredSessionToken } from '../lib/session';
import { NetworkLogo } from './network-marks';

/** The chains a service can be listed under, mirroring the directory's filter tabs. */
const ONBOARDING_CHAINS = [
  { chainId: 48816, label: 'GOAT', logoId: 'goat-mainnet' },
  { chainId: 56, label: 'BNB', logoId: 'bnb' },
  { chainId: 968, label: 'BOT Chain', logoId: 'bot-chain' },
] as const;

type OnboardingForm = Readonly<{
  organizationName: string;
  externalServiceId: string;
  serviceName: string;
  x402Endpoint: string;
  openApiUrl: string;
  version: string;
  /** Shown on the marketplace card. Optional -- a private registration has nothing to describe. */
  description: string;
}>;

const emptyForm: OnboardingForm = {
  organizationName: '',
  externalServiceId: '',
  serviceName: '',
  x402Endpoint: '',
  openApiUrl: '',
  version: '1.0.0',
  description: '',
};

/** description is the only field that may legitimately be blank (see OnboardingForm). */
const OPTIONAL_FIELDS: ReadonlySet<keyof OnboardingForm> = new Set(['description']);

/**
 * Registers a real catalog entry for a service the caller controls, instead of the quote form
 * only ever being able to target the one pre-seeded self-test target. The version hash is the
 * server hashing the caller's own OpenAPI document, not a value typed in here -- "this exact
 * version" stays meaningful for a service nobody seeded ahead of time.
 */
export function ServiceOnboarding({
  requesterAddress,
  open,
  onOpenChange,
  onOnboarded,
}: Readonly<{
  requesterAddress: `0x${string}`;
  /** Controlled by the parent so the directory's "add your API" affordance opens this same panel. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOnboarded: (result: ServiceOnboardingResponse, apiBackend: ApiBackendId, chainId: number) => void;
}>) {
  const [form, setForm] = useState<OnboardingForm>(emptyForm);
  const [listPublicly, setListPublicly] = useState(false);
  const [chainId, setChainId] = useState<number>(48816);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ServiceOnboardingResponse | null>(null);

  function update(field: keyof OnboardingForm, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function submit() {
    // This lives inside the quote-request form's own <form> element, and nested <form> tags are
    // invalid HTML (a real React hydration error, not just a lint nit) -- so this is a plain div
    // with a click handler instead of a submit event, which also means the browser's native
    // required-field blocking doesn't run for us; check for it here instead.
    const missing = (Object.keys(form) as (keyof OnboardingForm)[]).some(
      (field) => !OPTIONAL_FIELDS.has(field) && form[field].trim() === '',
    );
    if (missing) {
      setError('All fields except the description are required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const apiBackend = backendForChainId(chainId);
      const client = createApiClient(apiBackend, () => getStoredSessionToken(requesterAddress, apiBackend));
      await ensureSession(client, requesterAddress, apiBackend);
      const { description, ...service } = form;
      const onboarded = await client.onboardService({
        ...service,
        requesterAddress,
        marketplaceListed: listPublicly,
        chainId,
        ...(description.trim() === '' ? {} : { description: description.trim() }),
      });
      setResult(onboarded);
      onOnboarded(onboarded, apiBackend, chainId);
    } catch (caught) {
      setError(caught instanceof ShipyardApiError ? `${caught.code}: ${caught.message}` : 'Onboarding failed');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className="link-toggle service-onboarding-toggle" onClick={() => onOpenChange(true)}>
        Test a different service instead →
      </button>
    );
  }

  return (
    <div className="service-onboarding state-in">
      <div className="service-onboarding-header">
        <span className="panel-sublabel">REGISTER YOUR OWN SERVICE</span>
        <button type="button" className="link-toggle" onClick={() => onOpenChange(false)}>
          Cancel
        </button>
      </div>
      <p className="ai-rationale">
        We fetch your OpenAPI document server-side and hash it, that hash becomes the exact version this run tests.
        Every onboarded service is checked against the same standard policy this pipeline actually enforces today.
      </p>
      {result ? (
        <div className="service-onboarding-result">
          <p>
            <strong>Registered.</strong> The quote form below now targets{' '}
            <span className="mono">{result.targetServiceId}</span>.
          </p>
        </div>
      ) : (
        // biome-ignore lint/a11y/noStaticElementInteractions: can't be a real nested <form> (see submit() above); Enter-to-submit is reimplemented here instead
        <div
          className="service-onboarding-form"
          onKeyDown={(event) => {
            // Enter is a newline inside the description textarea, not a submit -- only the
            // single-line inputs get the browser's usual Enter-to-submit behaviour back.
            if (event.key === 'Enter' && !(event.target instanceof HTMLTextAreaElement)) {
              event.preventDefault();
              void submit();
            }
          }}
        >
          <label className="field">
            <span>Your organization name</span>
            <input
              value={form.organizationName}
              onChange={(event) => update('organizationName', event.target.value)}
              placeholder="Acme Inc"
            />
          </label>
          <label className="field">
            <span>Service ID</span>
            <input
              value={form.externalServiceId}
              onChange={(event) => update('externalServiceId', event.target.value)}
              placeholder="service:acme-api"
            />
          </label>
          <label className="field">
            <span>Service name</span>
            <input
              value={form.serviceName}
              onChange={(event) => update('serviceName', event.target.value)}
              placeholder="Acme paid API"
            />
          </label>
          <label className="field">
            <span>Version</span>
            <input
              value={form.version}
              onChange={(event) => update('version', event.target.value)}
              placeholder="1.0.0"
            />
          </label>
          <label className="field">
            <span>Paid x402 endpoint</span>
            <input
              type="url"
              value={form.x402Endpoint}
              onChange={(event) => update('x402Endpoint', event.target.value)}
              placeholder="https://api.acme.com/paid/resource"
            />
          </label>
          <label className="field">
            <span>OpenAPI document URL</span>
            <input
              type="url"
              value={form.openApiUrl}
              onChange={(event) => update('openApiUrl', event.target.value)}
              placeholder="https://api.acme.com/openapi.json"
            />
          </label>
          <fieldset className="field onboarding-chain-field">
            <legend>Settlement chain</legend>
            <div className="onboarding-chain-choice">
              {ONBOARDING_CHAINS.map((option) => (
                <label
                  key={option.chainId}
                  className={chainId === option.chainId ? 'chain-tab chain-tab--active' : 'chain-tab'}
                >
                  <input
                    type="radio"
                    name="settlementChain"
                    className="chain-tab-input"
                    value={option.chainId}
                    checked={chainId === option.chainId}
                    onChange={() => setChainId(option.chainId)}
                  />
                  <NetworkLogo networkId={option.logoId} size={16} className="chain-tab-logo" />
                  {option.label}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="field field--checkbox">
            <input type="checkbox" checked={listPublicly} onChange={(event) => setListPublicly(event.target.checked)} />
            <span>
              List this service publicly in the directory
              <small>
                Off by default. Registering an endpoint to test it isn&apos;t consent to publish it — tick this only if
                you want anyone to be able to find and run assurance against it.
              </small>
            </span>
          </label>
          {listPublicly && (
            <label className="field">
              <span>Directory description</span>
              <textarea
                rows={3}
                maxLength={600}
                value={form.description}
                onChange={(event) => update('description', event.target.value)}
                placeholder="What this paid API does, and what a caller gets for their payment."
              />
            </label>
          )}
          {error && (
            <div className="error-card state-in" key={error}>
              <strong>Onboarding blocked</strong>
              <p>{error}</p>
            </div>
          )}
          <button className="primary-button" type="button" disabled={busy} onClick={submit}>
            {busy && <span className="spinner" aria-hidden="true" />}
            {busy ? 'Fetching and hashing your OpenAPI document…' : 'Register service'}
          </button>
        </div>
      )}
    </div>
  );
}
