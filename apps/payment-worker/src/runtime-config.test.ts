import { GOAT_MAINNET } from '@shipyard402/goat-network-config';
import { describe, expect, it } from 'vitest';

import { parsePaymentWorkerRuntimeConfig, PaymentWorkerConfigurationError } from './runtime-config.js';

const completeEnvironment = {
  GOATX402_API_URL: GOAT_MAINNET.flowApiUrl,
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

function scopedMerchantEnvironment(
  prefix: 'GOATX402_TESTNET3' | 'GOATX402_MAINNET',
  merchantId: string,
  apiUrl: string,
): NodeJS.ProcessEnv {
  return {
    [`${prefix}_API_URL`]: apiUrl,
    [`${prefix}_MERCHANT_ID`]: merchantId,
    [`${prefix}_API_KEY`]: `${merchantId}-key`,
    [`${prefix}_API_SECRET`]: `${merchantId}-secret`,
    [`${prefix}_TOKEN_ADDRESS`]: '0x1000000000000000000000000000000000000001',
    [`${prefix}_TOKEN_SYMBOL`]: 'REVIEWED',
    [`${prefix}_TOKEN_DECIMALS`]: '6',
    [`${prefix}_RECEIVING_ADDRESS`]: '0x2000000000000000000000000000000000000002',
    [`${prefix}_MINIMUM_ATOMIC_AMOUNT`]: '1',
    [`${prefix}_MAXIMUM_ATOMIC_AMOUNT`]: '100000000',
  };
}

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
    expect(() =>
      parsePaymentWorkerRuntimeConfig({
        ...completeEnvironment,
        GOAT_MAINNET_RPC_URL: 'https://attacker.example',
      }),
    ).toThrowError(/official origin/);
    expect(() =>
      parsePaymentWorkerRuntimeConfig({
        ...completeEnvironment,
        GOATX402_API_URL: 'https://attacker.example',
      }),
    ).toThrowError(/official origin/);
  });

  it('bounds polling and lease durations', () => {
    expect(() =>
      parsePaymentWorkerRuntimeConfig({
        ...completeEnvironment,
        PAYMENT_POLL_INTERVAL_MS: '10',
      }),
    ).toThrowError(/poll interval/);
    expect(() =>
      parsePaymentWorkerRuntimeConfig({
        ...completeEnvironment,
        PAYMENT_LEASE_SECONDS: '1000',
      }),
    ).toThrowError(/lease/);
  });

  it('requires an explicit TLS-defaulted database in production', () => {
    expect(() =>
      parsePaymentWorkerRuntimeConfig({
        ...completeEnvironment,
        APP_ENV: 'production',
      }),
    ).toThrowError(/PostgreSQL/);
    const config = parsePaymentWorkerRuntimeConfig({
      ...completeEnvironment,
      APP_ENV: 'production',
      DATABASE_URL: 'postgresql://database.example/shipyard',
    });
    expect(config.database.useTls).toBe(true);
  });

  it('uses isolated Testnet3 RPC, Flow API, and chain capability in development', () => {
    const config = parsePaymentWorkerRuntimeConfig({
      ...completeEnvironment,
      GOAT_NETWORK_ENVIRONMENT: 'testnet3',
      GOATX402_API_URL: 'https://flow-api.testnet3.goat.network',
      GOAT_TESTNET_RPC_URL: 'https://rpc.testnet3.goat.network',
    });
    expect(config).toMatchObject({
      goatEnvironment: 'testnet3',
      rpcUrl: 'https://rpc.testnet3.goat.network',
      merchant: { capability: { environment: 'testnet3', chainId: 48816 } },
    });
  });

  it('selects one network-scoped merchant without deleting or reading the other profile', () => {
    const config = parsePaymentWorkerRuntimeConfig({
      GOAT_NETWORK_ENVIRONMENT: 'mainnet',
      ...scopedMerchantEnvironment('GOATX402_TESTNET3', 'testnet-merchant', 'https://flow-api.testnet3.goat.network'),
      ...scopedMerchantEnvironment('GOATX402_MAINNET', 'mainnet-merchant', GOAT_MAINNET.flowApiUrl),
    });

    expect(config.merchant?.merchantId).toBe('mainnet-merchant');
    expect(config.merchant?.capability).toMatchObject({ environment: 'mainnet', chainId: 2345 });
  });

  it('refuses to start the production payment worker against Testnet3', () => {
    expect(() =>
      parsePaymentWorkerRuntimeConfig({
        ...completeEnvironment,
        APP_ENV: 'production',
        DATABASE_URL: 'postgresql://database.example/shipyard',
        GOAT_NETWORK_ENVIRONMENT: 'testnet3',
        GOATX402_API_URL: 'https://flow-api.testnet3.goat.network',
      }),
    ).toThrowError(/Production payment worker must use GOAT mainnet/);
  });
});

const completeBotChainEnvironment = {
  MERCHANT_ADAPTER: 'bot-chain-direct',
  BOTX402_MERCHANT_ID: 'shipyard-botchain',
  BOTX402_TOKEN_ADDRESS: '0x1000000000000000000000000000000000000001',
  BOTX402_TOKEN_SYMBOL: 'USDT',
  BOTX402_TOKEN_DECIMALS: '6',
  BOTX402_RECEIVING_ADDRESS: '0x2000000000000000000000000000000000000002',
  BOTX402_MINIMUM_ATOMIC_AMOUNT: '1',
  BOTX402_MAXIMUM_ATOMIC_AMOUNT: '100000000',
} satisfies NodeJS.ProcessEnv;

describe('BOT Chain payment worker runtime configuration', () => {
  it('does not require any GOAT credentials when bot-chain-direct is selected', () => {
    const config = parsePaymentWorkerRuntimeConfig(completeBotChainEnvironment);
    expect(config.merchantAdapter).toBe('bot-chain-direct');
    expect(config.merchant).toBeUndefined();
    expect(config.botChainMerchant?.capability).toMatchObject({
      environment: 'botChainTestnet',
      chainId: 968,
      mode: 'DIRECT_ERC20',
    });
    expect(config.botChainRpcUrl).toBe('https://rpc.bohr.life');
  });

  it('requires every BOT Chain merchant field', () => {
    expect(() =>
      parsePaymentWorkerRuntimeConfig({ MERCHANT_ADAPTER: 'bot-chain-direct', BOTX402_MERCHANT_ID: 'partial' }),
    ).toThrowError(PaymentWorkerConfigurationError);
  });

  it('rejects a BOT Chain RPC override that does not match the reviewed origin', () => {
    expect(() =>
      parsePaymentWorkerRuntimeConfig({
        ...completeBotChainEnvironment,
        BOTCHAIN_TESTNET_RPC_URL: 'https://attacker.example',
      }),
    ).toThrowError(PaymentWorkerConfigurationError);
  });
});
