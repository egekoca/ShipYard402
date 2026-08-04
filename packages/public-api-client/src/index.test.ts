import { describe, expect, it, vi } from 'vitest';

import { ShipyardApiClient } from './index.js';

describe('public API client boundary', () => {
  it('refuses plaintext non-local API origins', () => {
    expect(() => new ShipyardApiClient('http://api.example.com')).toThrow('HTTPS');
  });

  it('treats HTTP 402 as the expected payment-challenge response only on the challenge method', async () => {
    const fetchImplementation = vi.fn(async () => new Response(JSON.stringify({
      run: {
        id: 'run-fixed', status: 'PAYMENT_REQUIRED', revision: 2,
        createdAt: '2026-08-04T10:00:00.000Z', updatedAt: '2026-08-04T10:00:01.000Z',
      },
      payment: {
        status: 'CHECKOUT_VERIFIED', mode: 'ERC20_DIRECT', nextAction: 'PAY_X402_CHALLENGE',
        orderId: 'flow-order-fixed',
      },
    }), { status: 402, headers: { 'content-type': 'application/json' } }));
    const client = new ShipyardApiClient('http://127.0.0.1:3001', fetchImplementation as typeof fetch);

    await expect(client.requestPaymentChallenge('run-fixed')).resolves.toMatchObject({
      run: { status: 'PAYMENT_REQUIRED' },
      payment: { orderId: 'flow-order-fixed' },
    });
  });

  it('returns null instead of throwing when evidence is not built yet', async () => {
    const fetchImplementation = vi.fn(async () => new Response(JSON.stringify({ code: 'EVIDENCE_PACK_NOT_FOUND' }), {
      status: 404, headers: { 'content-type': 'application/json' },
    }));
    const client = new ShipyardApiClient('http://127.0.0.1:3001', fetchImplementation as typeof fetch);

    await expect(client.getEvidence('run-fixed')).resolves.toBeNull();
  });

  it('returns null instead of throwing when there is no attestation yet', async () => {
    const fetchImplementation = vi.fn(async () => new Response(JSON.stringify({ code: 'ATTESTATION_NOT_FOUND' }), {
      status: 404, headers: { 'content-type': 'application/json' },
    }));
    const client = new ShipyardApiClient('http://127.0.0.1:3001', fetchImplementation as typeof fetch);

    await expect(client.getAttestation('run-fixed')).resolves.toBeNull();
  });

  it('still throws for a non-404 evidence error, such as a misconfigured backend', async () => {
    const fetchImplementation = vi.fn(async () => new Response(JSON.stringify({ code: 'EVIDENCE_PACK_PROVIDER_UNAVAILABLE' }), {
      status: 503, headers: { 'content-type': 'application/json' },
    }));
    const client = new ShipyardApiClient('http://127.0.0.1:3001', fetchImplementation as typeof fetch);

    await expect(client.getEvidence('run-fixed')).rejects.toMatchObject({ code: 'EVIDENCE_PACK_PROVIDER_UNAVAILABLE' });
  });

  it('fetches a real attestation payload', async () => {
    const attestation = {
      runId: 'run-fixed',
      registryAddress: '0x07f6a55Fb88DD29e9A10802ce8d706dA26db8ddd',
      chainId: 48816,
      transactionHash: `0x${'dd'.repeat(32)}`,
      attestor: '0x8eb7E837242d6eE3Baa274F1750C644bF3E08c10',
      expiresAt: '2026-09-04T00:00:00.000Z',
      submittedAt: '2026-08-05T00:00:00.000Z',
    };
    const fetchImplementation = vi.fn(async () => new Response(JSON.stringify(attestation), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    const client = new ShipyardApiClient('http://127.0.0.1:3001', fetchImplementation as typeof fetch);

    await expect(client.getAttestation('run-fixed')).resolves.toEqual(attestation);
  });
});
