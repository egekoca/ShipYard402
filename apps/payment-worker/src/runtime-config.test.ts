import { GOAT_MAINNET } from '@shipyard402/goat-network-config';
import { describe, expect, it } from 'vitest';

import { parsePaymentWorkerRuntimeConfig, PaymentWorkerConfigurationError } from './runtime-config.js';

const completeEnvironment = {
  GOATX402_API_URL: GOAT_MAINNET.x402ApiUrl,
  GOATX402_MERCHANT_ID: 'reviewed-merchant',
  GOATX402_API_KEY: 'test-api-key',
  GOATX402_API_SECRET: 'test-api-secret',
  GOATX402_TOKEN_ADDRESS: '0x1000000000000000000000000000000000000001',
  GOATX402_TOKEN_SYMBOL: 'REVIEWED',
  GOATX402_TOKEN_DECIMALS: '6',
  GOATX402_RECEIVING_ADDRESS: '0x2000000000000000000000000000000000000002',
  GOATX402_MINIMUM_ATOMIC_AMOUNT: '1',
  GOATX402_MAXIMUM_ATOMIC_AMOUNT: '100000000',
} satisfies NodeJS.ProcessEnv;

describe('payment worker runtime configuration', () => {
  it('requires every merchant credential and reviewed capability field', () => {
    expect(() => parsePaymentWorkerRuntimeConfig({})).toThrowError(PaymentWorkerConfigurationError);
  });

  it('accepts the official read-only RPC and x402 origins', () => {
    const config = parsePaymentWorkerRuntimeConfig({
      ...completeEnvironment,
      GOAT_MAINNET_RPC_URL: GOAT_MAINNET.publicRpcUrl,
      PAYMENT_WORKER_ID: 'payment-worker:test',
    });
    expect(config).toMatchObject({
      rpcUrl: 'https://rpc.goat.network',
      workerId: 'payment-worker:test',
      pollIntervalMilliseconds: 2000,
      leaseDurationSeconds: 60,
      merchant: { capability: { chainId: 2345, mode: 'ERC20_DIRECT' } },
    });
  });

  it('rejects arbitrary RPC and x402 hosts to prevent configuration-based SSRF', () => {
    expect(() => parsePaymentWorkerRuntimeConfig({
      ...completeEnvironment,
      GOAT_MAINNET_RPC_URL: 'https://attacker.example',
    })).toThrowError(/official origin/);
    expect(() => parsePaymentWorkerRuntimeConfig({
      ...completeEnvironment,
      GOATX402_API_URL: 'https://attacker.example',
    })).toThrowError(/official origin/);
  });

  it('bounds polling and lease durations', () => {
    expect(() => parsePaymentWorkerRuntimeConfig({
      ...completeEnvironment,
      PAYMENT_POLL_INTERVAL_MS: '10',
    })).toThrowError(/poll interval/);
    expect(() => parsePaymentWorkerRuntimeConfig({
      ...completeEnvironment,
      PAYMENT_LEASE_SECONDS: '1000',
    })).toThrowError(/lease/);
  });

  it('requires an explicit TLS-defaulted database in production', () => {
    expect(() => parsePaymentWorkerRuntimeConfig({
      ...completeEnvironment,
      APP_ENV: 'production',
    })).toThrowError(/PostgreSQL/);
    const config = parsePaymentWorkerRuntimeConfig({
      ...completeEnvironment,
      APP_ENV: 'production',
      DATABASE_URL: 'postgresql://database.example/shipyard',
    });
    expect(config.database.useTls).toBe(true);
  });
});
