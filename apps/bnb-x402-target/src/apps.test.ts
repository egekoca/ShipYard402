import { afterEach, describe, expect, it } from 'vitest';

import { createControlledBnbTargetApp } from './apps.js';
import { BNB_CANONICAL_USDC, BNB_CANONICAL_USDT } from './runtime-config.js';

const BASE = {
  facilitatorHost: '127.0.0.1' as const,
  facilitatorPort: 3013,
  payTo: '0x4000000000000000000000000000000000000004' as const,
  priceAtomic: '100000000000000',
};

let app: ReturnType<typeof createControlledBnbTargetApp> | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('controlled BNB x402 target — settlement asset', () => {
  it('runs as a real app and advertises USDC as its settlement asset when configured for USDC', async () => {
    // Boots the actual target app in-process (no chain, no facilitator) and confirms the USDC
    // settlement config flows all the way through to what the running server reports. The full 402
    // challenge additionally needs the facilitator up, which is an integration concern exercised by
    // running the real services; here we prove the asset wiring end-to-end through the live app.
    app = createControlledBnbTargetApp({ ...BASE, settlementAsset: BNB_CANONICAL_USDC });
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({
      status: 'ok',
      network: 'eip155:56',
      priceAtomic: BASE.priceAtomic,
      protocolVersion: 2,
    });
    expect(String(health.json().asset).toLowerCase()).toBe(BNB_CANONICAL_USDC.toLowerCase());
  });

  it('still advertises USDT when that is the configured asset', async () => {
    app = createControlledBnbTargetApp({ ...BASE, settlementAsset: BNB_CANONICAL_USDT });
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(String(health.json().asset).toLowerCase()).toBe(BNB_CANONICAL_USDT.toLowerCase());
  });
});
