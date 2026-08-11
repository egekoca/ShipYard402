import { getAddress, isAddress, isHex, recoverTypedDataAddress, type Hex, type TypedDataDomain } from 'viem';

/**
 * The `exact` scheme for EVM chains, exactly as Coinbase's x402 defines it: a payer signs an
 * EIP-3009 `TransferWithAuthorization` over the resource server's advertised (asset, payTo, value)
 * and hands the signature to the server in an `X-PAYMENT` header; the server recovers the signer,
 * checks the terms, and settles it on-chain by calling `transferWithAuthorization` on the token.
 *
 * This module is the pure protocol core shared by both sides -- no HTTP, no chain I/O. The client
 * builds and signs an authorization; the server decodes and verifies the header. On-chain
 * settlement (submitting the signed authorization) lives with whoever holds a funded settler
 * wallet, on top of `verifyExactEvmPayment` having already passed.
 */

export const EXACT_SCHEME = 'exact' as const;

/** The x402 protocol version this core implements, echoed in the 402 body and the payment header. */
export const X402_VERSION = 1 as const;

/**
 * The EIP-712 typed-data shape for EIP-3009. This is fixed by the standard: a conformant token's
 * own `transferWithAuthorization` recovers the signer over exactly these fields, so the signature
 * the server verifies here is the same one the token will accept at settlement.
 */
export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

/** CAIP-2-style network id for an EVM chain, e.g. `eip155:48816`. */
export function eip155Network(chainId: number): string {
  return `eip155:${chainId}`;
}

export function chainIdFromNetwork(network: string): number | null {
  const match = /^eip155:(\d+)$/.exec(network);
  return match ? Number(match[1]) : null;
}

/**
 * One `accepts` entry of a 402 response for the exact-evm scheme. `asset` is the ERC-20 the payer
 * signs against and doubles as the EIP-712 `verifyingContract`; `extra.name`/`extra.version` are
 * that token's EIP-712 domain fields, which the payer needs to reproduce the exact digest the
 * token will check at settlement.
 */
export type ExactEvmRequirements = Readonly<{
  scheme: typeof EXACT_SCHEME;
  network: string;
  /** Atomic token units. `exact` means the payment must be for precisely this amount. */
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: `0x${string}`;
  asset: `0x${string}`;
  maxTimeoutSeconds: number;
  extra: Readonly<{ name: string; version: string }>;
}>;

export type TransferAuthorization = Readonly<{
  from: `0x${string}`;
  to: `0x${string}`;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: `0x${string}`;
}>;

export type ExactEvmPayload = Readonly<{
  signature: `0x${string}`;
  authorization: TransferAuthorization;
}>;

export type PaymentHeader = Readonly<{
  x402Version: number;
  scheme: typeof EXACT_SCHEME;
  network: string;
  payload: ExactEvmPayload;
}>;

export type BuildRequirementsInput = Readonly<{
  chainId: number;
  amountAtomic: string;
  resource: string;
  payTo: `0x${string}`;
  asset: `0x${string}`;
  tokenName: string;
  tokenVersion: string;
  description?: string;
  mimeType?: string;
  maxTimeoutSeconds?: number;
}>;

/** Server side: the single `accepts` entry a resource server advertises for this paid route. */
export function buildExactEvmRequirements(input: BuildRequirementsInput): ExactEvmRequirements {
  if (!/^\d+$/.test(input.amountAtomic) || BigInt(input.amountAtomic) <= 0n) {
    throw new Error('amountAtomic must be a positive integer string');
  }
  return {
    scheme: EXACT_SCHEME,
    network: eip155Network(input.chainId),
    maxAmountRequired: input.amountAtomic,
    resource: input.resource,
    description: input.description ?? '',
    mimeType: input.mimeType ?? 'application/json',
    payTo: getAddress(input.payTo),
    asset: getAddress(input.asset),
    maxTimeoutSeconds: input.maxTimeoutSeconds ?? 300,
    extra: { name: input.tokenName, version: input.tokenVersion },
  };
}

/**
 * The EIP-712 domain for a requirements entry. `verifyingContract` is the asset itself, which is
 * what binds a signature to one specific token: a signature made for token A cannot settle on
 * token B because B computes a different domain separator.
 */
export function domainForRequirements(requirements: ExactEvmRequirements): TypedDataDomain {
  const chainId = chainIdFromNetwork(requirements.network);
  if (chainId === null) throw new Error(`Requirements carry a non-EVM network: ${requirements.network}`);
  return {
    name: requirements.extra.name,
    version: requirements.extra.version,
    chainId,
    verifyingContract: requirements.asset,
  };
}

export type SignAuthorizationInput = Readonly<{
  requirements: ExactEvmRequirements;
  from: `0x${string}`;
  /** 32-byte hex; a fresh random value per payment. The token consumes it, so reuse is a replay. */
  nonce: `0x${string}`;
  validAfterSec: number;
  validBeforeSec: number;
  /** Signs EIP-712 typed data -- e.g. viem's `privateKeyToAccount(pk).signTypedData`. */
  signTypedData: (args: {
    domain: TypedDataDomain;
    types: typeof TRANSFER_WITH_AUTHORIZATION_TYPES;
    primaryType: 'TransferWithAuthorization';
    message: Record<string, unknown>;
  }) => Promise<`0x${string}`>;
}>;

/**
 * Client side: build the authorization for the exact advertised amount and sign it. The value is
 * taken from the requirements, never from the caller -- `exact` means the payer commits to the
 * server's stated price, not one of its own choosing.
 */
export async function signExactEvmAuthorization(input: SignAuthorizationInput): Promise<ExactEvmPayload> {
  if (!isHex(input.nonce) || input.nonce.length !== 66) {
    throw new Error('nonce must be 32-byte hex');
  }
  if (!Number.isInteger(input.validAfterSec) || !Number.isInteger(input.validBeforeSec)) {
    throw new Error('validity window bounds must be integer unix seconds');
  }
  if (input.validBeforeSec <= input.validAfterSec) {
    throw new Error('validBefore must be after validAfter');
  }
  const authorization: TransferAuthorization = {
    from: getAddress(input.from),
    to: input.requirements.payTo,
    value: input.requirements.maxAmountRequired,
    validAfter: String(input.validAfterSec),
    validBefore: String(input.validBeforeSec),
    nonce: input.nonce,
  };
  const signature = await input.signTypedData({
    domain: domainForRequirements(input.requirements),
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: authorizationMessage(authorization),
  });
  return { signature, authorization };
}

/** The typed-data message, with numeric fields as bigint the way viem's signer expects them. */
export function authorizationMessage(authorization: TransferAuthorization): Record<string, unknown> {
  return {
    from: authorization.from,
    to: authorization.to,
    value: BigInt(authorization.value),
    validAfter: BigInt(authorization.validAfter),
    validBefore: BigInt(authorization.validBefore),
    nonce: authorization.nonce,
  };
}

export function encodePaymentHeader(header: PaymentHeader): string {
  return Buffer.from(JSON.stringify(header), 'utf8').toString('base64');
}

/**
 * Decodes and structurally validates an `X-PAYMENT` header. Rejects anything malformed before any
 * signature work -- a tampered or truncated header should read as "no valid payment", not throw
 * deep inside signature recovery. Returns null on any structural problem.
 */
export function decodePaymentHeader(encoded: string): PaymentHeader | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const header = parsed as Record<string, unknown>;
  if (header['scheme'] !== EXACT_SCHEME) return null;
  if (typeof header['network'] !== 'string') return null;
  if (typeof header['x402Version'] !== 'number') return null;
  const payload = header['payload'];
  if (typeof payload !== 'object' || payload === null) return null;
  const { signature, authorization } = payload as Record<string, unknown>;
  if (!isHex(signature) || (signature as string).length !== 132) return null;
  const auth = normalizeAuthorization(authorization);
  if (!auth) return null;
  return {
    x402Version: header['x402Version'] as number,
    scheme: EXACT_SCHEME,
    network: header['network'] as string,
    payload: { signature: signature as `0x${string}`, authorization: auth },
  };
}

function normalizeAuthorization(value: unknown): TransferAuthorization | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const { from, to, value: amount, validAfter, validBefore, nonce } = raw;
  if (!isAddress(from as string) || !isAddress(to as string)) return null;
  if (!isUintString(amount) || !isUintString(validAfter) || !isUintString(validBefore)) return null;
  if (!isHex(nonce) || (nonce as string).length !== 66) return null;
  return {
    from: getAddress(from as string),
    to: getAddress(to as string),
    value: amount as string,
    validAfter: validAfter as string,
    validBefore: validBefore as string,
    nonce: nonce as `0x${string}`,
  };
}

function isUintString(value: unknown): value is string {
  return typeof value === 'string' && /^\d+$/.test(value);
}

export type VerifyInput = Readonly<{
  header: PaymentHeader;
  requirements: ExactEvmRequirements;
  nowSec: number;
}>;

export type VerifyResult = Readonly<{
  valid: boolean;
  failureCodes: readonly string[];
  authorization: TransferAuthorization;
  /** The address the signature actually recovers to; equals authorization.from on a valid payment. */
  signer: `0x${string}` | null;
}>;

/**
 * Server side: is this header a payment that the advertised token would actually settle right now?
 * Checks every term the settlement will depend on -- scheme/network/asset match, exact amount, the
 * recovered signer being the stated payer, and the validity window covering now -- so the server
 * never spends gas submitting an authorization that would revert. It does NOT check the on-chain
 * nonce (that is the token's job at settlement) and does NOT check balance.
 */
export async function verifyExactEvmPayment(input: VerifyInput): Promise<VerifyResult> {
  const { header, requirements } = input;
  const authorization = header.payload.authorization;
  const failures: string[] = [];

  if (header.scheme !== requirements.scheme) failures.push('SCHEME_MISMATCH');
  if (header.network !== requirements.network) failures.push('NETWORK_MISMATCH');
  if (!sameAddress(authorization.to, requirements.payTo)) failures.push('PAY_TO_MISMATCH');
  if (authorization.value !== requirements.maxAmountRequired) failures.push('AMOUNT_MISMATCH');

  const validAfter = Number(authorization.validAfter);
  const validBefore = Number(authorization.validBefore);
  if (input.nowSec < validAfter) failures.push('AUTHORIZATION_NOT_YET_VALID');
  if (input.nowSec >= validBefore) failures.push('AUTHORIZATION_EXPIRED');

  // Recover last: if the terms above are already wrong, the signature is moot, but we still want
  // its failure reported when the terms match, so it always runs unless the header is off-network
  // (a mismatched domain would recover a meaningless address and bury the real NETWORK_MISMATCH).
  let signer: `0x${string}` | null = null;
  if (!failures.includes('NETWORK_MISMATCH')) {
    try {
      signer = await recoverTypedDataAddress({
        domain: domainForRequirements(requirements),
        types: TRANSFER_WITH_AUTHORIZATION_TYPES,
        primaryType: 'TransferWithAuthorization',
        message: authorizationMessage(authorization) as never,
        signature: header.payload.signature,
      });
    } catch {
      signer = null;
    }
    if (!signer || !sameAddress(signer, authorization.from)) failures.push('SIGNATURE_MISMATCH');
  }

  return { valid: failures.length === 0, failureCodes: failures, authorization, signer };
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/** Convenience: the settlement call arguments an EIP-3009 token expects, split from a signature. */
export function settlementArgs(payload: ExactEvmPayload): Readonly<{
  from: `0x${string}`;
  to: `0x${string}`;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: `0x${string}`;
  signature: Hex;
}> {
  const a = payload.authorization;
  return {
    from: a.from,
    to: a.to,
    value: BigInt(a.value),
    validAfter: BigInt(a.validAfter),
    validBefore: BigInt(a.validBefore),
    nonce: a.nonce,
    signature: payload.signature,
  };
}
