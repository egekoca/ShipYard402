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
    ).toThrowError(/reviewed mainnet origin/);
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
