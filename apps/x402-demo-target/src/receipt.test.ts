import { describe, expect, it } from 'vitest';

import { DemoReceiptInvalidError, issueDemoReceipt, verifyDemoReceipt } from './receipt.js';

const SECRET = 'a'.repeat(32);
const NOW = new Date('2026-08-05T00:00:00.000Z');

describe('demo payment receipt', () => {
  it('round-trips a freshly issued receipt', () => {
    const token = issueDemoReceipt(
      { orderId: 'order-1', atomicAmount: '1000', resource: '/paid/resource', validForSeconds: 60 },
      SECRET,
      NOW,
    );
    const receipt = verifyDemoReceipt(token, SECRET, NOW);
    expect(receipt).toMatchObject({ orderId: 'order-1', atomicAmount: '1000', resource: '/paid/resource' });
  });

  it('verifies the same receipt token repeatedly (it is only a proof-of-payment, not a redemption record)', () => {
    const token = issueDemoReceipt(
      { orderId: 'order-2', atomicAmount: '1000', resource: '/paid/resource', validForSeconds: 60 },
      SECRET,
      NOW,
    );
    expect(() => verifyDemoReceipt(token, SECRET, NOW)).not.toThrow();
    expect(() => verifyDemoReceipt(token, SECRET, NOW)).not.toThrow();
  });

  it('rejects a receipt once it has expired', () => {
    const token = issueDemoReceipt(
      { orderId: 'order-3', atomicAmount: '1000', resource: '/paid/resource', validForSeconds: 1 },
      SECRET,
      NOW,
    );
    const afterExpiry = new Date(NOW.getTime() + 2_000);
    expect(() => verifyDemoReceipt(token, SECRET, afterExpiry)).toThrow(DemoReceiptInvalidError);
  });

  it('rejects a receipt signed with a different secret', () => {
    const token = issueDemoReceipt(
      { orderId: 'order-4', atomicAmount: '1000', resource: '/paid/resource', validForSeconds: 60 },
      SECRET,
      NOW,
    );
    expect(() => verifyDemoReceipt(token, 'b'.repeat(32), NOW)).toThrow(DemoReceiptInvalidError);
  });

  it('rejects a tampered payload even if the signature segment is preserved', () => {
    const token = issueDemoReceipt(
      { orderId: 'order-5', atomicAmount: '1000', resource: '/paid/resource', validForSeconds: 60 },
      SECRET,
      NOW,
    );
    const [, signature] = token.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({
        orderId: 'order-5',
        atomicAmount: '999999999',
        resource: '/paid/resource',
        issuedAt: NOW.toISOString(),
        expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
      }),
      'utf8',
    ).toString('base64url');
    expect(() => verifyDemoReceipt(`${forgedPayload}.${signature}`, SECRET, NOW)).toThrow(DemoReceiptInvalidError);
  });

  it('rejects a malformed token', () => {
    expect(() => verifyDemoReceipt('not-a-real-token', SECRET, NOW)).toThrow(DemoReceiptInvalidError);
  });
});
