import { describe, expect, it } from 'vitest';

import { GOAT_MAINNET, GOAT_TESTNET3, flowRuntimeCapabilitySchema } from './index.js';

const baseCapability = {
  merchantId: 'merchant-1',
  mode: 'ERC20_DIRECT' as const,
  tokenAddress: '0x1000000000000000000000000000000000000001',
  tokenSymbol: 'REVIEWED_TOKEN',
  tokenDecimals: 18,
  receivingAddress: '0x2000000000000000000000000000000000000002',
  minimumAtomicAmount: '1',
  maximumAtomicAmount: '1000',
  discoveredAt: '2026-08-04T13:00:00.000Z',
  source: 'PORTAL_REVIEW' as const,
};

describe('GOAT network configuration', () => {
  it('pins the reviewed mainnet and Testnet3 network identities and Flow API origins', () => {
    expect(GOAT_MAINNET).toMatchObject({
      chainId: 2345,
      publicRpcUrl: 'https://rpc.goat.network',
      flowApiUrl: 'https://flow-api.goat.network',
    });
    expect(GOAT_TESTNET3).toMatchObject({
      chainId: 48816,
      publicRpcUrl: 'https://rpc.testnet3.goat.network',
      flowApiUrl: 'https://flow-api.testnet3.goat.network',
    });
  });

  it('rejects capabilities whose chain does not match their environment', () => {
    const result = flowRuntimeCapabilitySchema.safeParse({
      ...baseCapability,
      environment: 'testnet3',
      chainId: GOAT_MAINNET.chainId,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ['chainId'], message: 'Chain does not match testnet3' }),
      ]));
    }
  });
});
