import { describe, expect, it, vi } from 'vitest';

import type { TransactionHash } from '@shipyard402/x402-payments';

import { LayerZeroScanClient } from './layerzero-scan-client.js';

const SOURCE_HASH = `0x${'1'.repeat(64)}` as TransactionHash;
const DESTINATION_HASH = `0x${'2'.repeat(64)}` as TransactionHash;

describe('LayerZeroScanClient', () => {
  it('selects only the reviewed GOAT to BNB pathway and reads destination execution', async () => {
    const fetchImplementation = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                source: { eid: 30361 },
                destination: {
                  eid: 30102,
                  status: 'SUCCEEDED',
                  tx: { txHash: DESTINATION_HASH },
                },
                status: { name: 'DELIVERED' },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    ) as typeof fetch;
    const client = new LayerZeroScanClient({
      sourceEndpointId: 30361,
      destinationEndpointId: 30102,
      fetchImplementation,
    });

    await expect(client.getDelivery(SOURCE_HASH)).resolves.toEqual({
      status: 'DELIVERED',
      destinationStatus: 'SUCCEEDED',
      destinationTransactionHash: DESTINATION_HASH,
    });
    expect(fetchImplementation).toHaveBeenCalledWith(
      new URL(`https://scan.layerzero-api.com/v1/messages/tx/${SOURCE_HASH}`),
      undefined,
    );
  });

  it('returns pending-compatible null while the transaction is not indexed', async () => {
    const client = new LayerZeroScanClient({
      sourceEndpointId: 30361,
      destinationEndpointId: 30102,
      fetchImplementation: vi.fn(async () => new Response(null, { status: 404 })) as typeof fetch,
    });

    await expect(client.getDelivery(SOURCE_HASH)).resolves.toBeNull();
  });
});
