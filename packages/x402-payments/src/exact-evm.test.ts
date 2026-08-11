import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';

import {
  buildExactEvmRequirements,
  chainIdFromNetwork,
  decodePaymentHeader,
  domainForRequirements,
  eip155Network,
  encodePaymentHeader,
  settlementArgs,
  signExactEvmAuthorization,
  verifyExactEvmPayment,
  X402_VERSION,
  type ExactEvmRequirements,
  type PaymentHeader,
} from './exact-evm.js';

const CHAIN_ID = 48816;
const ASSET = '0x1111111111111111111111111111111111111111' as const;
const PAY_TO = '0x2222222222222222222222222222222222222222' as const;
// A fixed disposable test key -- its address is the payer in every case below.
const PAYER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
const payer = privateKeyToAccount(PAYER_KEY);

const NOW = 1_800_000_000;

function requirements(overrides: Partial<Parameters<typeof buildExactEvmRequirements>[0]> = {}): ExactEvmRequirements {
  return buildExactEvmRequirements({
    chainId: CHAIN_ID,
    amountAtomic: '1000',
    resource: 'https://target.example/paid/resource',
    payTo: PAY_TO,
    asset: ASSET,
    tokenName: 'Shipyard Testnet Token',
    tokenVersion: '1',
    ...overrides,
  });
}

async function signedHeader(
  reqs: ExactEvmRequirements,
  overrides: Partial<{ nonce: `0x${string}`; validAfterSec: number; validBeforeSec: number }> = {},
): Promise<PaymentHeader> {
  const payload = await signExactEvmAuthorization({
    requirements: reqs,
    from: payer.address,
    nonce: overrides.nonce ?? `0x${'ab'.repeat(32)}`,
    validAfterSec: overrides.validAfterSec ?? NOW - 10,
    validBeforeSec: overrides.validBeforeSec ?? NOW + 300,
    signTypedData: (args) => payer.signTypedData(args),
  });
  return { x402Version: X402_VERSION, scheme: 'exact', network: eip155Network(CHAIN_ID), payload };
}

describe('network id helpers', () => {
  it('round-trips an EVM chain id through the CAIP-2 form', () => {
    expect(eip155Network(CHAIN_ID)).toBe('eip155:48816');
    expect(chainIdFromNetwork('eip155:48816')).toBe(CHAIN_ID);
    expect(chainIdFromNetwork('stellar:testnet')).toBeNull();
  });
});

describe('buildExactEvmRequirements', () => {
  it('checksums addresses and carries the token domain in extra', () => {
    const reqs = requirements();
    expect(reqs.scheme).toBe('exact');
    expect(reqs.network).toBe('eip155:48816');
    expect(reqs.extra).toEqual({ name: 'Shipyard Testnet Token', version: '1' });
    expect(domainForRequirements(reqs)).toEqual({
      name: 'Shipyard Testnet Token',
      version: '1',
      chainId: CHAIN_ID,
      verifyingContract: ASSET,
    });
  });

  it('rejects a non-positive amount', () => {
    expect(() => requirements({ amountAtomic: '0' })).toThrow(/positive/);
  });
});

describe('sign -> encode -> decode -> verify (real signatures)', () => {
  it('accepts a well-formed payment the payer actually signed', async () => {
    const reqs = requirements();
    const header = await signedHeader(reqs);
    const round = decodePaymentHeader(encodePaymentHeader(header));
    expect(round).not.toBeNull();

    const result = await verifyExactEvmPayment({ header: round!, requirements: reqs, nowSec: NOW });
    expect(result.failureCodes).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.signer?.toLowerCase()).toBe(payer.address.toLowerCase());
  });

  it('commits the payer to the exact advertised amount, not a chosen one', async () => {
    const reqs = requirements({ amountAtomic: '5000' });
    const header = await signedHeader(reqs);
    expect(header.payload.authorization.value).toBe('5000');
    expect(header.payload.authorization.to.toLowerCase()).toBe(PAY_TO.toLowerCase());
  });

  it('exposes the exact settlement args an EIP-3009 token consumes', async () => {
    const header = await signedHeader(requirements());
    const args = settlementArgs(header.payload);
    expect(args.value).toBe(1000n);
    expect(args.nonce).toBe(`0x${'ab'.repeat(32)}`);
    expect(args.signature).toBe(header.payload.signature);
  });
});

describe('verifyExactEvmPayment rejects tampering', () => {
  it('rejects an amount raised after signing (forged terms)', async () => {
    const reqs = requirements();
    const header = await signedHeader(reqs);
    const tampered: PaymentHeader = {
      ...header,
      payload: { ...header.payload, authorization: { ...header.payload.authorization, value: '999999' } },
    };
    const result = await verifyExactEvmPayment({ header: tampered, requirements: reqs, nowSec: NOW });
    expect(result.valid).toBe(false);
    // Amount no longer matches the ad, and the signature no longer recovers to `from`.
    expect(result.failureCodes).toContain('AMOUNT_MISMATCH');
    expect(result.failureCodes).toContain('SIGNATURE_MISMATCH');
  });

  it('rejects a redirected recipient', async () => {
    const reqs = requirements();
    const header = await signedHeader(reqs);
    const attacker = '0x3333333333333333333333333333333333333333';
    const tampered: PaymentHeader = {
      ...header,
      payload: { ...header.payload, authorization: { ...header.payload.authorization, to: attacker } },
    };
    const result = await verifyExactEvmPayment({ header: tampered, requirements: reqs, nowSec: NOW });
    expect(result.failureCodes).toContain('PAY_TO_MISMATCH');
  });

  it('rejects a signature lifted onto a different token (domain mismatch)', async () => {
    const reqs = requirements();
    const header = await signedHeader(reqs);
    // Same header, but verified against requirements naming a different asset -> different domain.
    const otherToken = requirements({ asset: '0x4444444444444444444444444444444444444444' });
    const result = await verifyExactEvmPayment({ header, requirements: otherToken, nowSec: NOW });
    expect(result.failureCodes).toContain('SIGNATURE_MISMATCH');
  });

  it('rejects a payment presented before its window opens or after it closes', async () => {
    const reqs = requirements();
    const header = await signedHeader(reqs, { validAfterSec: NOW + 100, validBeforeSec: NOW + 400 });
    const early = await verifyExactEvmPayment({ header, requirements: reqs, nowSec: NOW });
    expect(early.failureCodes).toContain('AUTHORIZATION_NOT_YET_VALID');

    const header2 = await signedHeader(reqs, { validAfterSec: NOW - 400, validBeforeSec: NOW - 100 });
    const late = await verifyExactEvmPayment({ header: header2, requirements: reqs, nowSec: NOW });
    expect(late.failureCodes).toContain('AUTHORIZATION_EXPIRED');
  });

  it('reports a network mismatch and does not bury it behind signature recovery', async () => {
    const reqs = requirements();
    const header = { ...(await signedHeader(reqs)), network: 'eip155:1' };
    const result = await verifyExactEvmPayment({ header, requirements: reqs, nowSec: NOW });
    expect(result.failureCodes).toContain('NETWORK_MISMATCH');
    expect(result.failureCodes).not.toContain('SIGNATURE_MISMATCH');
  });
});

describe('decodePaymentHeader hardening', () => {
  it('returns null on non-base64 / non-JSON junk', () => {
    expect(decodePaymentHeader('!!!! not base64 !!!!')).toBeNull();
    expect(decodePaymentHeader(Buffer.from('not json', 'utf8').toString('base64'))).toBeNull();
  });

  it('returns null when the scheme is not exact', () => {
    const encoded = encodePaymentHeader({
      x402Version: X402_VERSION,
      scheme: 'exact',
      network: 'eip155:48816',
      payload: {
        signature: `0x${'11'.repeat(65)}`,
        authorization: {
          from: PAY_TO,
          to: PAY_TO,
          value: '1',
          validAfter: '0',
          validBefore: '10',
          nonce: `0x${'00'.repeat(32)}`,
        },
      },
    });
    const swapped = Buffer.from(
      Buffer.from(encoded, 'base64').toString('utf8').replace('"exact"', '"bogus"'),
      'utf8',
    ).toString('base64');
    expect(decodePaymentHeader(swapped)).toBeNull();
  });

  it('returns null on a malformed signature length', () => {
    const encoded = encodePaymentHeader({
      x402Version: X402_VERSION,
      scheme: 'exact',
      network: 'eip155:48816',
      payload: {
        signature: '0xdead' as `0x${string}`,
        authorization: {
          from: PAY_TO,
          to: PAY_TO,
          value: '1',
          validAfter: '0',
          validBefore: '10',
          nonce: `0x${'00'.repeat(32)}`,
        },
      },
    });
    expect(decodePaymentHeader(encoded)).toBeNull();
  });
});
