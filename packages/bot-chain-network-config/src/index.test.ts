import { describe, expect, it } from 'vitest';

import {
  BOT_CHAIN_MAINNET,
  BOT_CHAIN_TESTNET,
  botChainRuntimeCapabilitySchema,
  parseBotChainMerchantCapability,
  resolveBotChainNetwork,
  resolveBotChainRpcUrl,
} from './index.js';

class TestConfigurationError extends Error {
  readonly fields: readonly string[];
  constructor(message: string, fields: readonly string[]) {
    super(message);
    this.name = 'TestConfigurationError';
    this.fields = fields;
  }
}

function throwTestError(message: string, fields: readonly string[]): never {
  throw new TestConfigurationError(message, fields);
}

const baseCapability = {
  merchantId: 'merchant-1',
  mode: 'DIRECT_ERC20' as const,
  tokenAddress: '0x1000000000000000000000000000000000000001',
  tokenSymbol: 'REVIEWED_TOKEN',
  tokenDecimals: 18,
  receivingAddress: '0x2000000000000000000000000000000000000002',
  minimumAtomicAmount: '1',
  maximumAtomicAmount: '1000',
  discoveredAt: '2026-08-13T13:00:00.000Z',
  source: 'STATIC_CONFIG' as const,
};

describe('BOT Chain network configuration', () => {
  it('pins the reviewed mainnet and testnet network identities', () => {
    expect(BOT_CHAIN_MAINNET).toMatchObject({ chainId: 677, publicRpcUrl: 'https://rpc.botchain.ai' });
    expect(BOT_CHAIN_TESTNET).toMatchObject({ chainId: 968, publicRpcUrl: 'https://rpc.bohr.life' });
  });

  it('rejects capabilities whose chain does not match their environment', () => {
    const result = botChainRuntimeCapabilitySchema.safeParse({
      ...baseCapability,
      environment: 'botChainTestnet',
      chainId: BOT_CHAIN_MAINNET.chainId,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: ['chainId'], message: 'Chain does not match botChainTestnet' }),
        ]),
      );
    }
  });

  it('rejects a minimum amount greater than the maximum', () => {
    const result = botChainRuntimeCapabilitySchema.safeParse({
      ...baseCapability,
      environment: 'botChainTestnet',
      chainId: BOT_CHAIN_TESTNET.chainId,
      minimumAtomicAmount: '1000',
      maximumAtomicAmount: '1',
    });
    expect(result.success).toBe(false);
  });
});

describe('resolveBotChainNetwork', () => {
  it('maps environments to their network identities', () => {
    expect(resolveBotChainNetwork('botChainMainnet')).toBe(BOT_CHAIN_MAINNET);
    expect(resolveBotChainNetwork('botChainTestnet')).toBe(BOT_CHAIN_TESTNET);
  });
});

describe('resolveBotChainRpcUrl', () => {
  it('falls back to the reviewed public RPC URL when no override is given', () => {
    expect(resolveBotChainRpcUrl('botChainMainnet', {}, throwTestError)).toBe(BOT_CHAIN_MAINNET.publicRpcUrl);
    expect(resolveBotChainRpcUrl('botChainTestnet', {}, throwTestError)).toBe(BOT_CHAIN_TESTNET.publicRpcUrl);
  });

  it('accepts a matching override for the selected environment only', () => {
    expect(
      resolveBotChainRpcUrl('botChainMainnet', { mainnetRpcUrl: BOT_CHAIN_MAINNET.publicRpcUrl }, throwTestError),
    ).toBe(BOT_CHAIN_MAINNET.publicRpcUrl);
  });

  it('rejects an override that does not match the reviewed origin', () => {
    expect(() =>
      resolveBotChainRpcUrl('botChainMainnet', { mainnetRpcUrl: 'https://attacker.example' }, throwTestError),
    ).toThrow(TestConfigurationError);
  });
});

describe('parseBotChainMerchantCapability', () => {
  it('fills in mode, source, chainId, and discoveredAt from the environment', () => {
    const result = parseBotChainMerchantCapability({
      environment: 'botChainTestnet',
      merchantId: 'merchant-1',
      tokenAddress: '0x1000000000000000000000000000000000000001',
      tokenSymbol: 'USDT',
      tokenDecimals: 6,
      receivingAddress: '0x2000000000000000000000000000000000000002',
      minimumAtomicAmount: '1',
      maximumAtomicAmount: '1000',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mode).toBe('DIRECT_ERC20');
      expect(result.data.source).toBe('STATIC_CONFIG');
      expect(result.data.chainId).toBe(BOT_CHAIN_TESTNET.chainId);
    }
  });

  it('surfaces schema validation failures, e.g. an invalid token address', () => {
    const result = parseBotChainMerchantCapability({
      environment: 'botChainTestnet',
      merchantId: 'merchant-1',
      tokenAddress: 'not-an-address',
      tokenSymbol: 'USDT',
      tokenDecimals: 6,
      receivingAddress: '0x2000000000000000000000000000000000000002',
      minimumAtomicAmount: '1',
      maximumAtomicAmount: '1000',
    });

    expect(result.success).toBe(false);
  });
});
