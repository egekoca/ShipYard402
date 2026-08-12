import { describe, expect, it } from 'vitest';

import { parseMerchantOrderSnapshot } from './merchant-order-snapshot.js';

const order = {
  orderId: 'bot_1234',
  dappOrderId: 'run_1234',
  status: 'CHECKOUT_VERIFIED',
  chainId: 968,
  tokenAddress: '0x1213319c60D2749409BBeA32e79450464F5dFd09',
  atomicAmount: '1421052',
  payerAddress: '0x146CD395C3f25fc6E3C94180109baD6C9786C126',
  payToAddress: '0xC8de73D720E3FE011F9B47639AE648E78D7e2DF5',
  expiresAt: '2026-08-17T12:00:00.000Z',
  paymentRequired: {
    x402Version: 1,
    resource: { url: 'https://target.example/paid/resource' },
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:968',
        amount: '1421052',
        asset: '0x1213319c60D2749409BBeA32e79450464F5dFd09',
        payTo: '0xC8de73D720E3FE011F9B47639AE648E78D7e2DF5',
        maxTimeoutSeconds: 1800,
      },
    ],
  },
};

describe('merchant order snapshot parsing', () => {
  it('reads the flat snapshot the GOAT Flow store writes', () => {
    expect(parseMerchantOrderSnapshot(order)).toMatchObject({ orderId: 'bot_1234', chainId: 968 });
  });

  it('reads the wrapped snapshot the BOT Chain store writes', () => {
    const wrapped = { order, submittedTransactionHash: `0x${'ab'.repeat(32)}` };
    expect(parseMerchantOrderSnapshot(wrapped)).toMatchObject({ orderId: 'bot_1234', chainId: 968 });
  });

  it('rejects a snapshot that is neither', () => {
    expect(() => parseMerchantOrderSnapshot({ nope: true })).toThrowError();
    expect(() => parseMerchantOrderSnapshot({ order: { orderId: 'incomplete' } })).toThrowError();
  });
});
