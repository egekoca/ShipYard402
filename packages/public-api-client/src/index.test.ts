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
});
