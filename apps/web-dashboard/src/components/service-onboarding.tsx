'use client';

import { ShipyardApiClient, ShipyardApiError, type ServiceOnboardingResponse } from '@shipyard402/public-api-client';
import { useState } from 'react';

type OnboardingForm = Readonly<{
  organizationName: string;
  externalServiceId: string;
  serviceName: string;
  x402Endpoint: string;
  openApiUrl: string;
  version: string;
}>;

const emptyForm: OnboardingForm = {
  organizationName: '',
  externalServiceId: '',
  serviceName: '',
  x402Endpoint: '',
  openApiUrl: '',
  version: '1.0.0',
};

/**
 * Registers a real catalog entry for a service the caller controls, instead of the quote form
 * only ever being able to target the one pre-seeded self-test target. The version hash is the
 * server hashing the caller's own OpenAPI document, not a value typed in here -- "this exact
 * version" stays meaningful for a service nobody seeded ahead of time.
 */
export function ServiceOnboarding({
  requesterAddress,
  onOnboarded,
}: Readonly<{
  requesterAddress: `0x${string}`;
  onOnboarded: (result: ServiceOnboardingResponse) => void;
}>) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<OnboardingForm>(emptyForm);
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
    if (Object.values(form).some((value) => value.trim() === '')) {
      setError('All fields are required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const client = new ShipyardApiClient(process.env['NEXT_PUBLIC_SHIPYARD_API_URL'] ?? 'http://127.0.0.1:3001');
      const onboarded = await client.onboardService({ ...form, requesterAddress });
      setResult(onboarded);
      onOnboarded(onboarded);
    } catch (caught) {
      setError(caught instanceof ShipyardApiError ? `${caught.code}: ${caught.message}` : 'Onboarding failed');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className="link-toggle service-onboarding-toggle" onClick={() => setOpen(true)}>
        Test a different service instead →
      </button>
    );
  }

  return (
    <div className="service-onboarding state-in">
      <div className="service-onboarding-header">
        <span className="panel-sublabel">REGISTER YOUR OWN SERVICE</span>
        <button type="button" className="link-toggle" onClick={() => setOpen(false)}>Cancel</button>
      </div>
      <p className="ai-rationale">
        We fetch your OpenAPI document server-side and hash it, that hash becomes the exact version
        this run tests. Every onboarded service is checked against the same standard policy this
        pipeline actually enforces today.
      </p>
      {result ? (
        <div className="service-onboarding-result">
          <p><strong>Registered.</strong> The quote form below now targets <span className="mono">{result.targetServiceId}</span>.</p>
        </div>
      ) : (
        <div className="service-onboarding-form" onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void submit(); } }}>
          <label className="field">
            <span>Your organization name</span>
            <input value={form.organizationName} onChange={(event) => update('organizationName', event.target.value)} placeholder="Acme Inc" />
          </label>
          <label className="field">
            <span>Service ID</span>
            <input value={form.externalServiceId} onChange={(event) => update('externalServiceId', event.target.value)} placeholder="service:acme-api" />
          </label>
          <label className="field">
            <span>Service name</span>
            <input value={form.serviceName} onChange={(event) => update('serviceName', event.target.value)} placeholder="Acme paid API" />
          </label>
          <label className="field">
            <span>Version</span>
            <input value={form.version} onChange={(event) => update('version', event.target.value)} placeholder="1.0.0" />
          </label>
          <label className="field">
            <span>Paid x402 endpoint</span>
            <input type="url" value={form.x402Endpoint} onChange={(event) => update('x402Endpoint', event.target.value)} placeholder="https://api.acme.com/paid/resource" />
          </label>
          <label className="field">
            <span>OpenAPI document URL</span>
            <input type="url" value={form.openApiUrl} onChange={(event) => update('openApiUrl', event.target.value)} placeholder="https://api.acme.com/openapi.json" />
          </label>
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
