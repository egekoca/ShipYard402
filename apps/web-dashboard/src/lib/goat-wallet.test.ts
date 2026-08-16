import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  connectWallet,
  DEFAULT_CHAIN_ID,
  encodeErc20Transfer,
  ensureChain,
  formatWalletError,
  getAuthorizedAccount,
  GOAT_CHAINS,
  GOAT_TESTNET3_CHAIN_ID,
  isWalletAvailable,
  readErc20Balance,
  sendErc20Payment,
  signPersonalMessage,
} from './goat-wallet';

const ADDRESS = '0xAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaa' as const;
const TOKEN = '0xCcCCccCcCCCcCCCcCCCcCcCcCcCcCCCcCcccCCCc';

/** Stands in for the EIP-1193 provider a wallet extension injects, so the request/response
 * handling below is exercised without a real wallet. */
function stubWallet(request: (args: Readonly<{ method: string; params?: readonly unknown[] }>) => Promise<unknown>) {
  const spy = vi.fn(request);
  (globalThis as { window?: unknown }).window = { ethereum: { request: spy } };
  return spy;
}

describe('DEFAULT_CHAIN_ID', () => {
  it("defaults to GOAT Testnet3 so an unset deployment reproduces today's behavior", () => {
    expect(DEFAULT_CHAIN_ID).toBe(GOAT_TESTNET3_CHAIN_ID);
  });
});

describe('GOAT_CHAINS', () => {
  it('includes a BOT Chain testnet entry alongside the two GOAT entries', () => {
    expect(GOAT_CHAINS[968]).toMatchObject({
      chainIdHex: '0x3c8',
      chainName: 'BOT Chain Testnet',
      nativeCurrency: { symbol: 'BOT', decimals: 18 },
    });
    expect(GOAT_CHAINS[2345]).toBeDefined();
    expect(GOAT_CHAINS[48816]).toBeDefined();
  });

  it('includes BNB mainnet so a BNB catalog selection can add or switch the wallet', () => {
    expect(GOAT_CHAINS[56]).toMatchObject({
      chainIdHex: '0x38',
      chainName: 'BNB Smart Chain',
      nativeCurrency: { symbol: 'BNB', decimals: 18 },
    });
  });
});

describe('isWalletAvailable', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('is false when there is no window (e.g. server-side rendering)', () => {
    expect(isWalletAvailable()).toBe(false);
  });

  it('is false when window exists but no wallet extension injected window.ethereum', () => {
    (globalThis as { window?: unknown }).window = {};
    expect(isWalletAvailable()).toBe(false);
  });

  it('is true once window.ethereum is present', () => {
    (globalThis as { window?: unknown }).window = { ethereum: { request: async () => null } };
    expect(isWalletAvailable()).toBe(true);
  });
});

describe('encodeErc20Transfer', () => {
  it('encodes the ERC-20 transfer(address,uint256) selector, padded recipient, and padded amount', () => {
    const encoded = encodeErc20Transfer('0x1111111111111111111111111111111111111111', '256');
    expect(encoded).toBe(
      '0xa9059cbb' +
        '0000000000000000000000001111111111111111111111111111111111111111' +
        '0000000000000000000000000000000000000000000000000000000000000100',
    );
    expect(encoded).toHaveLength(138);
  });

  it('lowercases a mixed-case recipient address', () => {
    const encoded = encodeErc20Transfer('0xABCDEF1234567890abcdef1234567890ABCDEF12', '0');
    expect(encoded.slice(10, 74)).toBe('000000000000000000000000abcdef1234567890abcdef1234567890abcdef12');
  });

  it('rejects a recipient that is not a well-formed 20-byte address', () => {
    expect(() => encodeErc20Transfer('not-an-address', '1')).toThrow('Invalid ERC-20 recipient address');
  });
});

describe('formatWalletError', () => {
  it('recognizes EIP-1193 user-rejection (code 4001) as a friendly rejection message', () => {
    expect(formatWalletError({ code: 4001 })).toBe('Rejected in wallet.');
  });

  it('falls back to the Error message for a real Error instance', () => {
    expect(formatWalletError(new Error('provider disconnected'))).toBe('provider disconnected');
  });

  it('falls back to a generic message for anything else', () => {
    expect(formatWalletError('boom')).toBe('Unexpected wallet error');
    expect(formatWalletError(null)).toBe('Unexpected wallet error');
  });
});

describe('connectWallet', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('prompts for accounts and returns the first one', async () => {
    const request = stubWallet(async () => [ADDRESS]);
    await expect(connectWallet()).resolves.toBe(ADDRESS);
    expect(request).toHaveBeenCalledWith({ method: 'eth_requestAccounts' });
  });

  it('fails loudly when the wallet approves the request but returns no account', async () => {
    stubWallet(async () => []);
    await expect(connectWallet()).rejects.toThrow('did not return an account');
  });

  it('reports the missing extension rather than dereferencing an absent provider', async () => {
    await expect(connectWallet()).rejects.toThrow('No browser wallet extension was detected.');
  });
});

describe('getAuthorizedAccount', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  /** This runs on page load to restore a connection; it must never open a wallet prompt, which is
   * exactly what eth_requestAccounts (rather than eth_accounts) would do. */
  it('asks for already-granted accounts without prompting', async () => {
    const request = stubWallet(async () => [ADDRESS]);
    await expect(getAuthorizedAccount()).resolves.toBe(ADDRESS);
    expect(request).toHaveBeenCalledWith({ method: 'eth_accounts' });
  });

  it('returns null when the site has no standing permission yet', async () => {
    stubWallet(async () => []);
    await expect(getAuthorizedAccount()).resolves.toBeNull();
  });

  it('returns null instead of throwing when no wallet is installed', async () => {
    await expect(getAuthorizedAccount()).resolves.toBeNull();
  });
});

describe('ensureChain', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('does nothing when the wallet is already on the requested chain', async () => {
    const request = stubWallet(async () => '0xbeb0');
    await ensureChain(GOAT_TESTNET3_CHAIN_ID);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith({ method: 'eth_chainId' });
  });

  it('treats the reported chain id case-insensitively', async () => {
    const request = stubWallet(async () => '0xBEB0');
    await ensureChain(GOAT_TESTNET3_CHAIN_ID);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('switches the wallet when it is on a different chain', async () => {
    let activeChain = '0x1';
    const request = stubWallet(async ({ method }) => {
      if (method === 'eth_chainId') return activeChain;
      if (method === 'wallet_switchEthereumChain') activeChain = '0xbeb0';
      return null;
    });
    await ensureChain(GOAT_TESTNET3_CHAIN_ID);
    expect(request).toHaveBeenCalledWith({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: '0xbeb0' }],
    });
  });

  /** 4902 means the wallet has never heard of this chain -- common for GOAT and BOT Chain, which
   * ship in no wallet by default. Adding it is the only way the customer can proceed. */
  it('adds the chain with its full definition when the wallet does not know it (4902)', async () => {
    let activeChain = '0x1';
    let added = false;
    const request = stubWallet(async ({ method }) => {
      if (method === 'eth_chainId') return activeChain;
      if (method === 'wallet_switchEthereumChain') {
        if (!added) throw Object.assign(new Error('Unrecognized chain'), { code: 4902 });
        activeChain = '0xbeb0';
      }
      if (method === 'wallet_addEthereumChain') added = true;
      return null;
    });

    await ensureChain(GOAT_TESTNET3_CHAIN_ID);

    expect(request).toHaveBeenCalledWith({
      method: 'wallet_addEthereumChain',
      params: [expect.objectContaining({ chainId: '0xbeb0', chainName: 'GOAT Testnet3' })],
    });
  });

  it('refuses to continue when a provider resolves the switch but stays on the wrong chain', async () => {
    const request = stubWallet(async ({ method }) => (method === 'eth_chainId' ? '0x1' : null));

    await expect(ensureChain(968)).rejects.toThrow('Wallet remained on chain 0x1; expected BOT Chain Testnet (0x3c8).');
    expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ method: 'eth_sendTransaction' }));
  });

  it('propagates a rejected switch rather than silently adding the chain behind the customer', async () => {
    const request = stubWallet(async ({ method }) => {
      if (method === 'eth_chainId') return '0x1';
      throw Object.assign(new Error('User rejected'), { code: 4001 });
    });

    await expect(ensureChain(GOAT_TESTNET3_CHAIN_ID)).rejects.toThrow('User rejected');
    expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ method: 'wallet_addEthereumChain' }));
  });

  it('refuses a chain id this build has no definition for, before touching the wallet', async () => {
    const request = stubWallet(async () => '0x1');
    await expect(ensureChain(999_999)).rejects.toThrow('Unrecognized EVM chain id: 999999');
    expect(request).not.toHaveBeenCalled();
  });
});

describe('sendErc20Payment', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('sends the transfer to the token contract with the customer as sender', async () => {
    const request = stubWallet(async () => `0x${'ab'.repeat(32)}`);

    const hash = await sendErc20Payment({
      fromAddress: ADDRESS,
      tokenAddress: TOKEN,
      toAddress: ADDRESS,
      amountAtomic: '5000000',
    });

    expect(hash).toBe(`0x${'ab'.repeat(32)}`);
    expect(request).toHaveBeenCalledWith({
      method: 'eth_sendTransaction',
      params: [{ from: ADDRESS, to: TOKEN, data: encodeErc20Transfer(ADDRESS, '5000000') }],
    });
  });

  /** A malformed token address would otherwise be encoded into a transaction the customer is asked
   * to sign -- caught here, before the wallet ever opens. */
  it('rejects a malformed token address without opening the wallet', async () => {
    const request = stubWallet(async () => null);

    await expect(
      sendErc20Payment({ fromAddress: ADDRESS, tokenAddress: '0xnope', toAddress: ADDRESS, amountAtomic: '1' }),
    ).rejects.toThrow('Invalid token address');
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects a malformed recipient address without opening the wallet', async () => {
    const request = stubWallet(async () => null);

    await expect(
      sendErc20Payment({ fromAddress: ADDRESS, tokenAddress: TOKEN, toAddress: 'not-an-address', amountAtomic: '1' }),
    ).rejects.toThrow('Invalid ERC-20 recipient address');
    expect(request).not.toHaveBeenCalled();
  });
});

describe('readErc20Balance', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('reads balanceOf on the active chain without opening a transaction', async () => {
    const request = stubWallet(async () => '0x2a');

    await expect(readErc20Balance(TOKEN, ADDRESS)).resolves.toBe(42n);
    expect(request).toHaveBeenCalledWith({
      method: 'eth_call',
      params: [
        {
          to: TOKEN,
          data: `0x70a08231${ADDRESS.toLowerCase().slice(2).padStart(64, '0')}`,
        },
        'latest',
      ],
    });
  });
});

describe('signPersonalMessage', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  /** The gateway recovers the signer from the exact bytes it reconstructs, so the message has to
   * reach the wallet as its UTF-8 hex encoding, with the address as the second parameter. */
  it('hex-encodes the message and passes the address as the signing account', async () => {
    const request = stubWallet(async () => `0x${'22'.repeat(65)}`);

    await expect(signPersonalMessage(ADDRESS, 'hi')).resolves.toBe(`0x${'22'.repeat(65)}`);
    expect(request).toHaveBeenCalledWith({ method: 'personal_sign', params: ['0x6869', ADDRESS] });
  });

  it('encodes multi-byte characters as UTF-8 rather than one byte per character', async () => {
    const request = stubWallet(async () => `0x${'22'.repeat(65)}`);

    await signPersonalMessage(ADDRESS, '\u20ac');

    expect(request).toHaveBeenCalledWith({ method: 'personal_sign', params: ['0xe282ac', ADDRESS] });
  });
});
