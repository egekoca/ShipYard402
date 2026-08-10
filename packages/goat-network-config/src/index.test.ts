import { describe, expect, it } from 'vitest';

import {
  ConfigurationError,
  GOAT_MAINNET,
  GOAT_TESTNET3,
  assertExactUrl,
  assertPostgresUrl,
  flowRuntimeCapabilitySchema,
  parseBoundedInt,
  parseMerchantCapability,
  resolveGoatMerchantProfile,
  resolveNetwork,
  resolveRpcUrl,
} from './index.js';

class TestConfigurationError extends ConfigurationError {
  constructor(message: string, fields: readonly string[]) {
    super(message, fields);
    this.name = 'TestConfigurationError';
  }
}

function throwTestError(message: string, fields: readonly string[]): never {
  throw new TestConfigurationError(message, fields);
}

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
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: ['chainId'], message: 'Chain does not match testnet3' }),
        ]),
      );
    }
  });
});

describe('resolveNetwork', () => {
  it('maps mainnet and testnet3 to their network identities', () => {
    expect(resolveNetwork('mainnet')).toBe(GOAT_MAINNET);
    expect(resolveNetwork('testnet3')).toBe(GOAT_TESTNET3);
  });
});

describe('ConfigurationError', () => {
  it('carries the offending fields and is a real Error subclass', () => {
    const error = new TestConfigurationError('bad config', ['FOO', 'BAR']);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('bad config');
    expect(error.fields).toEqual(['FOO', 'BAR']);
    expect(error.name).toBe('TestConfigurationError');
  });
});

describe('assertPostgresUrl', () => {
  it('accepts postgres and postgresql URLs with a host and database name', () => {
    expect(() => assertPostgresUrl('postgresql://user:pass@localhost:5432/shipyard', throwTestError)).not.toThrow();
    expect(() => assertPostgresUrl('postgres://localhost/shipyard', throwTestError)).not.toThrow();
  });

  it('rejects non-Postgres URLs, missing hosts, and missing database names', () => {
    expect(() => assertPostgresUrl('not a url', throwTestError)).toThrow(TestConfigurationError);
    expect(() => assertPostgresUrl('mysql://localhost/shipyard', throwTestError)).toThrow(TestConfigurationError);
    expect(() => assertPostgresUrl('postgresql:///shipyard', throwTestError)).toThrow(TestConfigurationError);
    expect(() => assertPostgresUrl('postgresql://localhost/', throwTestError)).toThrow(TestConfigurationError);
  });
});

describe('assertExactUrl', () => {
  it('accepts a URL whose origin matches exactly with no path, credentials, query, or fragment', () => {
    expect(() =>
      assertExactUrl('https://rpc.goat.network', 'https://rpc.goat.network', 'RPC_URL', throwTestError),
    ).not.toThrow();
    expect(() =>
      assertExactUrl('https://rpc.goat.network/', 'https://rpc.goat.network', 'RPC_URL', throwTestError),
    ).not.toThrow();
  });

  it('rejects a mismatched origin, embedded credentials, a path, a query, or a fragment', () => {
    expect(() =>
      assertExactUrl('https://attacker.example', 'https://rpc.goat.network', 'RPC_URL', throwTestError),
    ).toThrow(/RPC_URL/);
    expect(() =>
      assertExactUrl('https://user:pass@rpc.goat.network', 'https://rpc.goat.network', 'RPC_URL', throwTestError),
    ).toThrow();
    expect(() =>
      assertExactUrl('https://rpc.goat.network/extra', 'https://rpc.goat.network', 'RPC_URL', throwTestError),
    ).toThrow();
    expect(() =>
      assertExactUrl('https://rpc.goat.network?x=1', 'https://rpc.goat.network', 'RPC_URL', throwTestError),
    ).toThrow();
  });
});

describe('resolveRpcUrl', () => {
  it('falls back to the reviewed public RPC URL when no override is given', () => {
    expect(resolveRpcUrl('mainnet', {}, throwTestError)).toBe(GOAT_MAINNET.publicRpcUrl);
    expect(resolveRpcUrl('testnet3', {}, throwTestError)).toBe(GOAT_TESTNET3.publicRpcUrl);
  });

  it('accepts a matching override for the selected environment only', () => {
    expect(resolveRpcUrl('mainnet', { mainnetRpcUrl: GOAT_MAINNET.publicRpcUrl }, throwTestError)).toBe(
      GOAT_MAINNET.publicRpcUrl,
    );
  });

  it('rejects an override that does not match the reviewed origin', () => {
    expect(() => resolveRpcUrl('mainnet', { mainnetRpcUrl: 'https://attacker.example' }, throwTestError)).toThrow(
      TestConfigurationError,
    );
  });
});

describe('resolveGoatMerchantProfile', () => {
  const merchantFields = {
    API_KEY: 'key',
    API_SECRET: 'secret',
    TOKEN_ADDRESS: '0x1000000000000000000000000000000000000001',
    TOKEN_SYMBOL: 'USDC.e',
    TOKEN_DECIMALS: '6',
    RECEIVING_ADDRESS: '0x2000000000000000000000000000000000000002',
    MINIMUM_ATOMIC_AMOUNT: '1',
    MAXIMUM_ATOMIC_AMOUNT: '1000000',
  } as const;

  function profile(prefix: string, merchantId: string, apiUrl: string): Record<string, string> {
    return {
      [`${prefix}_API_URL`]: apiUrl,
      [`${prefix}_MERCHANT_ID`]: merchantId,
      ...Object.fromEntries(Object.entries(merchantFields).map(([suffix, value]) => [`${prefix}_${suffix}`, value])),
    };
  }

  it('keeps Testnet3 and mainnet profiles together but selects only the active network', () => {
    const environment = {
      ...profile('GOATX402_TESTNET3', 'testnet-merchant', GOAT_TESTNET3.flowApiUrl),
      ...profile('GOATX402_MAINNET', 'mainnet-merchant', GOAT_MAINNET.flowApiUrl),
    };

    expect(resolveGoatMerchantProfile('testnet3', environment, throwTestError).merchant?.merchantId).toBe(
      'testnet-merchant',
    );
    expect(resolveGoatMerchantProfile('mainnet', environment, throwTestError).merchant?.merchantId).toBe(
      'mainnet-merchant',
    );
  });

  it('retains the legacy single-profile group as a backwards-compatible fallback', () => {
    const resolved = resolveGoatMerchantProfile(
      'testnet3',
      profile('GOATX402', 'legacy-testnet-merchant', GOAT_TESTNET3.flowApiUrl),
      throwTestError,
    );

    expect(resolved.merchant?.merchantId).toBe('legacy-testnet-merchant');
    expect(resolved.apiUrlField).toBe('GOATX402_API_URL');
  });

  it('rejects an incomplete scoped profile instead of mixing it with a complete legacy profile', () => {
    const environment = {
      ...profile('GOATX402', 'legacy-mainnet-merchant', GOAT_MAINNET.flowApiUrl),
      GOATX402_MAINNET_API_URL: GOAT_MAINNET.flowApiUrl,
      GOATX402_MAINNET_MERCHANT_ID: 'partial-mainnet-merchant',
    };

    expect(() => resolveGoatMerchantProfile('mainnet', environment, throwTestError)).toThrow(TestConfigurationError);
    try {
      resolveGoatMerchantProfile('mainnet', environment, throwTestError);
    } catch (error) {
      expect((error as TestConfigurationError).fields).toContain('GOATX402_MAINNET_API_KEY');
    }
  });

  it('ignores a configured profile for the unselected network', () => {
    const resolved = resolveGoatMerchantProfile(
      'testnet3',
      profile('GOATX402_MAINNET', 'mainnet-merchant', GOAT_MAINNET.flowApiUrl),
      throwTestError,
    );

    expect(resolved.merchant).toBeUndefined();
    expect(resolved.expectedMerchantFields).toContain('GOATX402_TESTNET3_MERCHANT_ID');
  });
});

describe('parseMerchantCapability', () => {
  it('fills in mode, chainId, and discoveredAt from the environment', () => {
    const result = parseMerchantCapability({
      environment: 'mainnet',
      merchantId: 'merchant-1',
      tokenAddress: '0x1000000000000000000000000000000000000001',
      tokenSymbol: 'REVIEWED_TOKEN',
      tokenDecimals: 18,
      receivingAddress: '0x2000000000000000000000000000000000000002',
      minimumAtomicAmount: '1',
      maximumAtomicAmount: '1000',
      source: 'PORTAL_REVIEW',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mode).toBe('ERC20_DIRECT');
      expect(result.data.chainId).toBe(GOAT_MAINNET.chainId);
    }
  });

  it('surfaces schema validation failures, e.g. an invalid token address', () => {
    const result = parseMerchantCapability({
      environment: 'mainnet',
      merchantId: 'merchant-1',
      tokenAddress: 'not-an-address',
      tokenSymbol: 'REVIEWED_TOKEN',
      tokenDecimals: 18,
      receivingAddress: '0x2000000000000000000000000000000000000002',
      minimumAtomicAmount: '1',
      maximumAtomicAmount: '1000',
      source: 'PORTAL_REVIEW',
    });

    expect(result.success).toBe(false);
  });
});

describe('parseBoundedInt', () => {
  it('parses the raw value when present and within bounds', () => {
    expect(parseBoundedInt('3000', '1000', { min: 250, max: 60_000 })).toBe(3000);
  });

  it('falls back to the default value when raw is undefined', () => {
    expect(parseBoundedInt(undefined, '3000', { min: 250, max: 60_000 })).toBe(3000);
  });

  it('returns undefined when the value is out of bounds or not a safe integer', () => {
    expect(parseBoundedInt('100', '3000', { min: 250, max: 60_000 })).toBeUndefined();
    expect(parseBoundedInt('70000', '3000', { min: 250, max: 60_000 })).toBeUndefined();
    expect(parseBoundedInt('not-a-number', '3000', { min: 250, max: 60_000 })).toBeUndefined();
  });
});
