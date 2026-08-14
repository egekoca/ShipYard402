import { GOAT_MAINNET } from '@shipyard402/goat-network-config';
import { describe, expect, it } from 'vitest';

import { parseRuntimeConfig, RuntimeConfigurationError } from './runtime-config.js';

const completeMerchantEnvironment = {
  GOATX402_API_URL: GOAT_MAINNET.flowApiUrl,
  GOATX402_MERCHANT_ID: 'merchant-reviewed',
  GOATX402_API_KEY: 'api-key',
  GOATX402_API_SECRET: 'api-secret',
  GOATX402_TOKEN_ADDRESS: '0x1000000000000000000000000000000000000001',
  GOATX402_TOKEN_SYMBOL: 'REVIEWED',
  GOATX402_TOKEN_DECIMALS: '6',
  GOATX402_RECEIVING_ADDRESS: '0x2000000000000000000000000000000000000002',
  GOATX402_MINIMUM_ATOMIC_AMOUNT: '1',
  GOATX402_MAXIMUM_ATOMIC_AMOUNT: '100000000',
  SESSION_SIGNING_SECRET: 'a'.repeat(32),
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

describe('API runtime configuration', () => {
  it('uses the local PostgreSQL service in development without inventing merchant capability', () => {
    const config = parseRuntimeConfig({ APP_ENV: 'development' });

    expect(config.database).toEqual({
      connectionString: 'postgresql://shipyard:shipyard@127.0.0.1:5432/shipyard',
      useTls: false,
    });
    expect(config.merchant).toBeUndefined();
    expect(config.host).toBe('127.0.0.1');
  });

  it('accepts localhost and 127.0.0.1 aliases for the same development web origin port', () => {
    const config = parseRuntimeConfig({
      APP_ENV: 'development',
      WEB_ORIGIN: 'http://127.0.0.1:3006',
    });

    expect(config.allowedWebOrigins).toEqual(['http://127.0.0.1:3006', 'http://localhost:3006']);
  });

  it('does not broaden the production web origin allowlist', () => {
    const config = parseRuntimeConfig({
      APP_ENV: 'production',
      WEB_ORIGIN: 'http://127.0.0.1:3006',
      DATABASE_URL: 'postgresql://database.example/shipyard',
      ...completeMerchantEnvironment,
    });

    expect(config.allowedWebOrigins).toEqual(['http://127.0.0.1:3006']);
  });

  it('rejects partial merchant credentials instead of silently disabling payments', () => {
    expect(() =>
      parseRuntimeConfig({
        APP_ENV: 'development',
        GOATX402_MERCHANT_ID: 'merchant-only',
      }),
    ).toThrowError(RuntimeConfigurationError);
  });

  it('rejects an unreviewed GOAT x402 API origin', () => {
    expect(() =>
      parseRuntimeConfig({
        APP_ENV: 'development',
        GOATX402_API_URL: 'https://attacker.example',
      }),
    ).toThrowError(/reviewed official origin/);
  });

  it('requires PostgreSQL and merchant configuration in production', () => {
    expect(() => parseRuntimeConfig({ APP_ENV: 'production' })).toThrowError(/PostgreSQL/);
    expect(() =>
      parseRuntimeConfig({
        APP_ENV: 'production',
        DATABASE_URL: 'postgresql://database.example/shipyard',
      }),
    ).toThrowError(/merchant configuration/);
  });

  it('requires SESSION_SIGNING_SECRET in production even with merchant configuration complete', () => {
    expect(() =>
      parseRuntimeConfig({
        APP_ENV: 'production',
        DATABASE_URL: 'postgresql://database.example/shipyard',
        ...completeMerchantEnvironment,
        SESSION_SIGNING_SECRET: undefined,
      }),
    ).toThrowError(/SESSION_SIGNING_SECRET/);
  });

  it('accepts a complete reviewed production configuration', () => {
    const config = parseRuntimeConfig({
      APP_ENV: 'production',
      DATABASE_URL: 'postgresql://database.example/shipyard',
      ...completeMerchantEnvironment,
    });

    expect(config.host).toBe('0.0.0.0');
    expect(config.database.useTls).toBe(true);
    expect(config.merchant?.capability).toMatchObject({
      environment: 'mainnet',
      chainId: 2345,
      mode: 'ERC20_DIRECT',
      source: 'PORTAL_REVIEW',
    });
  });

  it('creates a Testnet3-scoped capability only when development selects Testnet3', () => {
    const config = parseRuntimeConfig({
      APP_ENV: 'development',
      GOAT_NETWORK_ENVIRONMENT: 'testnet3',
      ...completeMerchantEnvironment,
      GOATX402_API_URL: 'https://flow-api.testnet3.goat.network',
    });
    expect(config.goatEnvironment).toBe('testnet3');
    expect(config.merchant?.capability).toMatchObject({ environment: 'testnet3', chainId: 48816 });
  });

  it('selects the Testnet3 merchant while retaining a separate mainnet merchant profile', () => {
    const config = parseRuntimeConfig({
      APP_ENV: 'development',
      GOAT_NETWORK_ENVIRONMENT: 'testnet3',
      ...scopedMerchantEnvironment('GOATX402_MAINNET', 'mainnet-merchant', GOAT_MAINNET.flowApiUrl),
      GOATX402_MAINNET_API_KEY: '',
      ...scopedMerchantEnvironment('GOATX402_TESTNET3', 'testnet-merchant', 'https://flow-api.testnet3.goat.network'),
    });

    expect(config.merchant?.merchantId).toBe('testnet-merchant');
    expect(config.merchant?.capability).toMatchObject({ environment: 'testnet3', chainId: 48816 });
  });

  it('refuses to start the production API against Testnet3', () => {
    expect(() =>
      parseRuntimeConfig({
        APP_ENV: 'production',
        DATABASE_URL: 'postgresql://database.example/shipyard',
        GOAT_NETWORK_ENVIRONMENT: 'testnet3',
        ...completeMerchantEnvironment,
        GOATX402_API_URL: 'https://flow-api.testnet3.goat.network',
      }),
    ).toThrowError(/Production API must use GOAT mainnet/);
  });
});

const completeBotChainMerchantEnvironment = {
  MERCHANT_ADAPTER: 'bot-chain-direct',
  BOTX402_MERCHANT_ID: 'shipyard-botchain',
  BOTX402_TOKEN_ADDRESS: '0x1000000000000000000000000000000000000001',
  BOTX402_TOKEN_SYMBOL: 'USDT',
  BOTX402_TOKEN_DECIMALS: '6',
  BOTX402_RECEIVING_ADDRESS: '0x2000000000000000000000000000000000000002',
  BOTX402_MINIMUM_ATOMIC_AMOUNT: '1',
  BOTX402_MAXIMUM_ATOMIC_AMOUNT: '100000000',
  SESSION_SIGNING_SECRET: 'a'.repeat(32),
} satisfies NodeJS.ProcessEnv;

describe('BOT Chain merchant configuration', () => {
  it('defaults MERCHANT_ADAPTER to goat-flow, leaving BOT Chain unconfigured', () => {
    const config = parseRuntimeConfig({ APP_ENV: 'development' });
    expect(config.merchantAdapter).toBe('goat-flow');
    expect(config.botChainMerchant).toBeUndefined();
  });

  it('parses a complete BOT Chain merchant configuration, locked to testnet', () => {
    const config = parseRuntimeConfig({
      APP_ENV: 'development',
      ...completeBotChainMerchantEnvironment,
    });
    expect(config.merchantAdapter).toBe('bot-chain-direct');
    expect(config.botChainMerchant?.capability).toMatchObject({
      environment: 'botChainTestnet',
      chainId: 968,
      mode: 'DIRECT_ERC20',
      source: 'STATIC_CONFIG',
    });
    // Selecting bot-chain-direct doesn't require (or forbid) the unrelated GOAT merchant group.
    expect(config.merchant).toBeUndefined();
  });

  it('rejects an incomplete BOT Chain merchant field group', () => {
    expect(() =>
      parseRuntimeConfig({
        APP_ENV: 'development',
        MERCHANT_ADAPTER: 'bot-chain-direct',
        BOTX402_MERCHANT_ID: 'shipyard-botchain',
      }),
    ).toThrowError(RuntimeConfigurationError);
  });

  it('requires complete BOT Chain merchant configuration in production when selected', () => {
    expect(() =>
      parseRuntimeConfig({
        APP_ENV: 'production',
        DATABASE_URL: 'postgresql://database.example/shipyard',
        MERCHANT_ADAPTER: 'bot-chain-direct',
        SESSION_SIGNING_SECRET: 'a'.repeat(32),
      }),
    ).toThrowError(/Production requires complete reviewed BOT Chain x402 merchant configuration/);
  });

  it('accepts a production deployment fully configured for BOT Chain', () => {
    const config = parseRuntimeConfig({
      APP_ENV: 'production',
      DATABASE_URL: 'postgresql://database.example/shipyard',
      ...completeBotChainMerchantEnvironment,
    });
    expect(config.merchantAdapter).toBe('bot-chain-direct');
    expect(config.botChainMerchant).toBeDefined();
  });
});
