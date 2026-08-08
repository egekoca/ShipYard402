import { afterEach, describe, expect, it } from 'vitest';

import { encodeErc20Transfer, formatWalletError, isWalletAvailable } from './goat-wallet';

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
