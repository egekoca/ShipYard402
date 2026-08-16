import { describe, expect, it } from 'vitest';

import { ALL_NETWORKS, explorerTxUrl, networkByChainId, SHOWCASE_NETWORKS } from './networks';

describe('network registry', () => {
  it('resolves every network it lists by chain id', () => {
    for (const network of ALL_NETWORKS) {
      expect(networkByChainId(network.chainId)).toBe(network);
    }
  });

  it('never lists two networks under the same chain id', () => {
    const chainIds = ALL_NETWORKS.map((network) => network.chainId);
    expect(new Set(chainIds).size).toBe(chainIds.length);
  });

  it('only showcases networks it can also resolve', () => {
    for (const network of SHOWCASE_NETWORKS) {
      expect(ALL_NETWORKS).toContain(network);
    }
  });

  it('gives every network an explorer origin with no trailing slash', () => {
    for (const network of ALL_NETWORKS) {
      expect(network.explorerUrl).toMatch(/^https:\/\/[^/]+$/);
    }
  });
});

describe('explorerTxUrl', () => {
  it('routes GOAT mainnet (chain 2345) to the GOAT explorer', () => {
    expect(explorerTxUrl(2345, '0xabc')).toBe('https://explorer.goat.network/tx/0xabc');
  });

  it('routes GOAT Testnet3 (chain 48816) to the Testnet3 explorer', () => {
    expect(explorerTxUrl(48816, '0xabc')).toBe('https://explorer.testnet3.goat.network/tx/0xabc');
  });

  it('routes BNB Chain (chain 56) to BscScan', () => {
    expect(explorerTxUrl(56, '0xabc')).toBe('https://bscscan.com/tx/0xabc');
  });

  it('routes BOT Chain testnet (chain 968) to scan.bohr.life', () => {
    expect(explorerTxUrl(968, '0xabc')).toBe('https://scan.bohr.life/tx/0xabc');
  });

  it('routes BOT Chain mainnet (chain 677) to scan.botchain.ai', () => {
    expect(explorerTxUrl(677, '0xabc')).toBe('https://scan.botchain.ai/tx/0xabc');
  });

  it('returns null for an unknown chain instead of guessing another chain’s explorer', () => {
    // Linking a chain-1 hash to a GOAT explorer would render a real payment as a dead page,
    // which reads to the customer as "this never happened". Callers show plain text instead.
    expect(explorerTxUrl(1, '0xabc')).toBeNull();
  });
});
