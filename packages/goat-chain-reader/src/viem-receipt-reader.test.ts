import { describe, expect, it } from 'vitest';

import { ViemGoatReceiptReader, type GoatReadClient } from './viem-receipt-reader.js';

const txHash = `0x${'ab'.repeat(32)}` as const;

function client(chainId = 2345): GoatReadClient {
  return {
    async getChainId() { return chainId; },
    async getTransactionReceipt() { return {
      transactionHash: txHash,
      status: 'success',
      logs: [{
        address: '0x1000000000000000000000000000000000000001',
        topics: [`0x${'cd'.repeat(32)}`],
        data: '0x',
        logIndex: 2,
      }],
    }; },
  };
}

describe('Viem GOAT receipt reader', () => {
  it('normalizes a GOAT mainnet receipt without signer access', async () => {
    await expect(new ViemGoatReceiptReader(client()).getTransactionReceipt(2345, txHash)).resolves.toMatchObject({
      chainId: 2345,
      status: 1,
      logs: [{ index: 2 }],
    });
  });

  it('rejects an RPC endpoint serving a different chain', async () => {
    await expect(new ViemGoatReceiptReader(client(1)).getTransactionReceipt(2345, txHash)).rejects.toThrow('RPC chain mismatch');
  });
});
