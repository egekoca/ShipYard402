import { describe, expect, it } from 'vitest';

import { parseBnbX402RuntimeConfig } from './runtime-config.js';

const valid = {
  BNB_RPC_URL: 'https://bsc.example/rpc',
  BNB_FACILITATOR_PRIVATE_KEY: `0x${'1'.repeat(64)}`,
  BNB_X402_PAY_TO: '0x4000000000000000000000000000000000000004',
};

describe('BNB x402 runtime config', () => {
  it('defaults to loopback facilitator, a tightly capped PoC price, and USDT settlement', () => {
    expect(parseBnbX402RuntimeConfig(valid)).toMatchObject({
      facilitatorHost: '127.0.0.1',
      facilitatorPort: 3013,
      targetPort: 3012,
      priceAtomic: '100000000000000',
      maxPriceAtomic: '1000000000000000',
      settlementAssetSymbol: 'USDT',
      settlementAsset: '0x55d398326f99059fF775485246999027B3197955',
    });
  });

  it('settles in USDC when configured, resolving the canonical BNB USDC address', () => {
    const config = parseBnbX402RuntimeConfig({ ...valid, BNB_X402_SETTLEMENT_ASSET: 'USDC' });
    expect(config.settlementAssetSymbol).toBe('USDC');
    expect(config.settlementAsset).toBe('0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d');
  });

  it('refuses a publicly bound facilitator', () => {
    expect(() => parseBnbX402RuntimeConfig({ ...valid, BNB_FACILITATOR_HOST: '0.0.0.0' })).toThrow(
      /configuration is invalid/,
    );
  });

  it('refuses a target price over the independent safety ceiling', () => {
    expect(() =>
      parseBnbX402RuntimeConfig({
        ...valid,
        BNB_X402_PRICE_ATOMIC: '1001',
        BNB_X402_MAX_PRICE_ATOMIC: '1000',
      }),
    ).toThrow(/price exceeds/);
  });
});
