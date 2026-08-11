import { describe, expect, it } from 'vitest';

import { DemoTargetConfigurationError, parseDemoTargetRuntimeConfig } from './runtime-config.js';

const TOKEN = '0x1000000000000000000000000000000000000001';
const RECIPIENT = '0x3000000000000000000000000000000000000003';
const SETTLER_KEY = `0x${'11'.repeat(32)}`;

function baseEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    DEMO_MODE: 'V2_PROTECTED',
    DEMO_TARGET_TOKEN_ADDRESS: TOKEN,
    DEMO_TARGET_RECEIVING_ADDRESS: RECIPIENT,
    DEMO_TARGET_PRICE_ATOMIC: '1000',
    DEMO_TARGET_SETTLER_PRIVATE_KEY: SETTLER_KEY,
    ...overrides,
  };
}

describe('x402 demo target runtime configuration', () => {
  it('requires the settlement asset, recipient, price, and settler key', () => {
    expect(() => parseDemoTargetRuntimeConfig({})).toThrowError(DemoTargetConfigurationError);
    expect(() => parseDemoTargetRuntimeConfig({ DEMO_MODE: 'V2_PROTECTED' })).toThrowError(
      DemoTargetConfigurationError,
    );
  });

  it('rejects an unknown demo mode', () => {
    expect(() => parseDemoTargetRuntimeConfig(baseEnv({ DEMO_MODE: 'V3_UNKNOWN' }))).toThrowError(
      DemoTargetConfigurationError,
    );
  });

  it('rejects a non-positive price', () => {
    expect(() => parseDemoTargetRuntimeConfig(baseEnv({ DEMO_TARGET_PRICE_ATOMIC: '0' }))).toThrowError(
      DemoTargetConfigurationError,
    );
  });

  it('resolves testnet3 defaults and the settlement asset domain', () => {
    const config = parseDemoTargetRuntimeConfig(baseEnv());
    expect(config).toMatchObject({
      host: '127.0.0.1',
      port: 3002,
      mode: 'V2_PROTECTED',
      goatEnvironment: 'testnet3',
      rpcUrl: 'https://rpc.testnet3.goat.network',
      tokenAddress: TOKEN,
      tokenName: 'Shipyard Testnet Token',
      tokenVersion: '1',
      receivingAddress: RECIPIENT,
      priceAtomic: '1000',
      maxTimeoutSeconds: 300,
      settlerPrivateKey: SETTLER_KEY,
    });
    expect(config.chainId).toBe(48816);
  });

  it('settles on BOT Chain testnet when NETWORK selects it', () => {
    const config = parseDemoTargetRuntimeConfig(baseEnv({ NETWORK: 'bot-chain-testnet' }));
    expect(config).toMatchObject({
      network: 'bot-chain-testnet',
      chainId: 968,
      rpcUrl: 'https://rpc.bohr.life',
    });
  });

  it('rejects a BOT Chain RPC override that is not the documented endpoint', () => {
    expect(() =>
      parseDemoTargetRuntimeConfig(
        baseEnv({ NETWORK: 'bot-chain-testnet', BOTCHAIN_TESTNET_RPC_URL: 'https://rpc.example.com' }),
      ),
    ).toThrowError(DemoTargetConfigurationError);
  });

  it('honors an explicit host, port, and token domain override', () => {
    const config = parseDemoTargetRuntimeConfig(
      baseEnv({
        HOST: '0.0.0.0',
        PORT: '4100',
        DEMO_MODE: 'V1_VULNERABLE',
        DEMO_TARGET_TOKEN_NAME: 'Custom Token',
        DEMO_TARGET_TOKEN_VERSION: '2',
      }),
    );
    expect(config).toMatchObject({
      host: '0.0.0.0',
      port: 4100,
      mode: 'V1_VULNERABLE',
      tokenName: 'Custom Token',
      tokenVersion: '2',
    });
  });

  it('rejects an RPC origin that does not match the reviewed official origin', () => {
    expect(() =>
      parseDemoTargetRuntimeConfig(baseEnv({ GOAT_TESTNET_RPC_URL: 'https://evil.example/rpc' })),
    ).toThrowError(DemoTargetConfigurationError);
  });
});
