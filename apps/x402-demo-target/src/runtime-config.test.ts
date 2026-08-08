import { describe, expect, it } from 'vitest';

import { DemoTargetConfigurationError, parseDemoTargetRuntimeConfig } from './runtime-config.js';

describe('x402 demo target runtime configuration', () => {
  it('requires DEMO_MODE and a sufficiently long DEMO_RECEIPT_SECRET', () => {
    expect(() => parseDemoTargetRuntimeConfig({})).toThrowError(DemoTargetConfigurationError);
    expect(() =>
      parseDemoTargetRuntimeConfig({ DEMO_MODE: 'V1_VULNERABLE', DEMO_RECEIPT_SECRET: 'too-short' }),
    ).toThrowError(DemoTargetConfigurationError);
  });

  it('rejects an unknown demo mode', () => {
    expect(() =>
      parseDemoTargetRuntimeConfig({
        DEMO_MODE: 'V3_UNKNOWN',
        DEMO_RECEIPT_SECRET: 'a'.repeat(32),
      }),
    ).toThrowError(DemoTargetConfigurationError);
  });

  it('applies host and port defaults', () => {
    const config = parseDemoTargetRuntimeConfig({
      DEMO_MODE: 'V2_PROTECTED',
      DEMO_RECEIPT_SECRET: 'a'.repeat(32),
    });
    expect(config).toMatchObject({ host: '127.0.0.1', port: 3002, mode: 'V2_PROTECTED' });
  });

  it('honors an explicit host and port', () => {
    const config = parseDemoTargetRuntimeConfig({
      HOST: '0.0.0.0',
      PORT: '4100',
      DEMO_MODE: 'V1_VULNERABLE',
      DEMO_RECEIPT_SECRET: 'a'.repeat(32),
    });
    expect(config).toMatchObject({ host: '0.0.0.0', port: 4100, mode: 'V1_VULNERABLE' });
  });

  it('leaves purchase undefined when no receiving address is configured', () => {
    const config = parseDemoTargetRuntimeConfig({
      DEMO_MODE: 'V2_PROTECTED',
      DEMO_RECEIPT_SECRET: 'a'.repeat(32),
    });
    expect(config.purchase).toBeUndefined();
  });

  it('requires a minimum atomic amount once a receiving address is set', () => {
    expect(() =>
      parseDemoTargetRuntimeConfig({
        DEMO_MODE: 'V2_PROTECTED',
        DEMO_RECEIPT_SECRET: 'a'.repeat(32),
        DEMO_TARGET_RECEIVING_ADDRESS: '0x3000000000000000000000000000000000000003',
      }),
    ).toThrowError(DemoTargetConfigurationError);
  });

  it('defaults to testnet3 and its official RPC once purchase is configured', () => {
    const config = parseDemoTargetRuntimeConfig({
      DEMO_MODE: 'V2_PROTECTED',
      DEMO_RECEIPT_SECRET: 'a'.repeat(32),
      DEMO_TARGET_RECEIVING_ADDRESS: '0x3000000000000000000000000000000000000003',
      DEMO_TARGET_MINIMUM_ATOMIC_AMOUNT: '1000',
    });
    expect(config.purchase).toMatchObject({
      goatEnvironment: 'testnet3',
      rpcUrl: 'https://rpc.testnet3.goat.network',
      receivingAddress: '0x3000000000000000000000000000000000000003',
      minimumAtomicAmount: '1000',
      minimumConfirmations: 1,
    });
  });

  it('rejects an RPC origin that does not match the reviewed official origin', () => {
    expect(() =>
      parseDemoTargetRuntimeConfig({
        DEMO_MODE: 'V2_PROTECTED',
        DEMO_RECEIPT_SECRET: 'a'.repeat(32),
        DEMO_TARGET_RECEIVING_ADDRESS: '0x3000000000000000000000000000000000000003',
        DEMO_TARGET_MINIMUM_ATOMIC_AMOUNT: '1000',
        GOAT_TESTNET_RPC_URL: 'https://evil.example/rpc',
      }),
    ).toThrowError(DemoTargetConfigurationError);
  });
});
