import type { BotChainRuntimeCapability } from '@shipyard402/bot-chain-network-config';
import type { BotChainOrderContext } from '@shipyard402/bot-chain-adapter';
import type { MerchantOrder } from '@shipyard402/x402-payments';
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresBotChainOrderContextStore } from './bot-chain-order-context-store.js';

const token = '0x1000000000000000000000000000000000000001' as const;
const payer = '0x2000000000000000000000000000000000000002' as const;
const recipient = '0x3000000000000000000000000000000000000003' as const;
const transactionHash = `0x${'ab'.repeat(32)}` as const;

const order: MerchantOrder = {
  orderId: 'bot_abcdef',
  dappOrderId: 'run-1',
  status: 'CHECKOUT_VERIFIED',
  chainId: 968,
  tokenAddress: token,
  atomicAmount: '5000000',
  payerAddress: payer,
  payToAddress: recipient,
  expiresAt: '2026-08-13T12:00:00.000Z',
  paymentRequired: {
    x402Version: 1,
    resource: { url: 'botchain:order:run-1' },
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:968',
        amount: '5000000',
        asset: token,
        payTo: recipient,
        maxTimeoutSeconds: 1800,
      },
    ],
  },
};

const capability: BotChainRuntimeCapability = {
  environment: 'botChainTestnet',
  merchantId: 'shipyard-botchain',
  mode: 'DIRECT_ERC20',
  chainId: 968,
  tokenAddress: token,
  tokenSymbol: 'USDT',
  tokenDecimals: 6,
  receivingAddress: recipient,
  minimumAtomicAmount: '1',
  maximumAtomicAmount: '1000000000',
  discoveredAt: '2026-08-13T00:00:00.000Z',
  source: 'STATIC_CONFIG',
};

function fakePool(row: { order_snapshot: unknown; capability_snapshot: unknown } | null) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      if (sql.includes('INSERT INTO payment_orders')) return { rows: [] };
      if (sql.includes('FROM payment_orders')) return { rows: row ? [row] : [] };
      throw new Error(`Unexpected test query: ${sql}`);
    },
  } as unknown as Pool;
  return { pool, calls };
}

describe('PostgresBotChainOrderContextStore', () => {
  it('inserts a freshly created order with no submitted transaction or proof yet', async () => {
    const { pool, calls } = fakePool(null);
    const store = new PostgresBotChainOrderContextStore(pool);
    await store.put({ order, capability });

    const insertCall = calls.find((call) => call.sql.includes('INSERT INTO payment_orders'));
    expect(insertCall).toBeDefined();
    const snapshot = JSON.parse(insertCall!.params[10] as string);
    expect(snapshot).toEqual({ order });
  });

  it('round-trips a context with a submitted transaction hash and proof through get', async () => {
    const context: BotChainOrderContext = {
      order: { ...order, status: 'PAYMENT_CONFIRMED' },
      capability,
      submittedTransactionHash: transactionHash,
      proof: {
        orderId: order.orderId,
        transactionHash,
        logIndex: 2,
        fromAddress: payer,
        toAddress: recipient,
        atomicAmount: '5000000',
        chainId: 968,
      },
    };
    const { pool } = fakePool({
      order_snapshot: {
        order: context.order,
        submittedTransactionHash: context.submittedTransactionHash,
        proof: context.proof,
      },
      capability_snapshot: capability,
    });
    const store = new PostgresBotChainOrderContextStore(pool);

    await expect(store.get(order.orderId)).resolves.toEqual(context);
    await expect(store.getByDappOrderId(order.dappOrderId)).resolves.toEqual(context);
  });

  it('returns null for an unknown order', async () => {
    const { pool } = fakePool(null);
    const store = new PostgresBotChainOrderContextStore(pool);
    await expect(store.get('missing')).resolves.toBeNull();
  });
});
