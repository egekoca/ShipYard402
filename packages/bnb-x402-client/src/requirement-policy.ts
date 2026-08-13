import type { PaymentRequirements } from '@x402/core/types';
import { getAddress, isAddress } from 'viem';

import { bnbAssetInfo } from './constants.js';

/**
 * How a target's 402 challenge is judged before we sign anything for it.
 *
 * The earlier version pinned one exact tuple -- this recipient, this amount, this asset -- which
 * made the payer able to pay exactly one endpoint we had configured by hand. A real x402 service
 * publishes its own terms in the challenge and changes them whenever it likes, so what we can
 * usefully fix in advance is not the terms but the *limits*: which chain, which assets we actually
 * hold, which signatures we can produce, and how much we are willing to spend. Everything else is
 * read from the service.
 */

/**
 * The transfer methods `@x402/evm`'s exact scheme can actually sign. This is deliberately the
 * client library's capability set, not the wider set some facilitators advertise: promising a
 * method we cannot produce a signature for would fail at the last step, after the allowance is
 * already granted.
 *
 * Live BNB services do publish `permit2-exact` (CoinMarketCap's x402 endpoints price canonical
 * USDT that way), and `@x402/evm` 2.22.0 -- the newest published version -- implements only the
 * two below. Such a requirement is therefore reported as TRANSFER_METHOD_UNSUPPORTED rather than
 * silently attempted; widen this list only once the library actually gains the method.
 */
export const SUPPORTED_ASSET_TRANSFER_METHODS = ['eip3009', 'permit2'] as const;

export type AssetTransferMethod = (typeof SUPPORTED_ASSET_TRANSFER_METHODS)[number];

/** x402 leaves `extra.assetTransferMethod` optional, and the exact scheme defaults it to EIP-3009. */
export const DEFAULT_ASSET_TRANSFER_METHOD: AssetTransferMethod = 'eip3009';

export type X402PaymentPolicy = Readonly<{
  /** CAIP-2 network this payer holds funds on. A challenge for any other chain is unpayable. */
  network: string;
  /** Assets the payer actually holds on that chain -- in practice, whatever the bridge delivered. */
  allowedAssets: readonly `0x${string}`[];
  /** Hard ceiling for a single payment, in atomic units of the asset. */
  maximumAtomicAmount: string;
  /** Transfer methods to accept. Defaults to everything the client can sign. */
  allowedTransferMethods?: readonly AssetTransferMethod[];
  /**
   * Pins the recipient. Set it for a known counterparty (our own controlled target); leave it unset
   * to pay whatever recipient a discovered service publishes, still bounded by every limit above.
   */
  payTo?: `0x${string}`;
}>;

export type PayableRequirement = Readonly<{
  requirement: PaymentRequirements;
  amountAtomic: string;
  asset: `0x${string}`;
  payTo: `0x${string}`;
  transferMethod: AssetTransferMethod;
}>;

export type RejectedRequirement = Readonly<{ index: number; codes: readonly string[] }>;

export type RequirementSelection = Readonly<{
  payable?: PayableRequirement;
  rejected: readonly RejectedRequirement[];
}>;

/**
 * Picks the first entry of a 402 challenge this payer may settle, and explains every entry it
 * turned down. Rejections are returned rather than thrown so the caller can log exactly why a
 * service was unpayable -- "the asset is not one we hold" and "the price is above our ceiling" are
 * very different operational problems, and a single opaque failure hides which one happened.
 */
export function selectPayableRequirement(
  requirements: readonly PaymentRequirements[],
  policy: X402PaymentPolicy,
): RequirementSelection {
  const allowedMethods = policy.allowedTransferMethods ?? SUPPORTED_ASSET_TRANSFER_METHODS;
  const rejected: RejectedRequirement[] = [];

  for (const [index, requirement] of requirements.entries()) {
    const codes: string[] = [];

    if (requirement.scheme !== 'exact') codes.push('SCHEME_NOT_EXACT');
    if (requirement.network !== policy.network) codes.push('NETWORK_NOT_ALLOWED');

    const asset = normalizeAddress(requirement.asset);
    if (!asset) {
      codes.push('ASSET_MALFORMED');
    } else if (!policy.allowedAssets.some((allowed) => getAddress(allowed) === asset)) {
      // Not "unknown token" but "we do not hold this": the bridge delivers one settlement asset,
      // and signing against another would authorize a transfer that cannot clear.
      codes.push('ASSET_NOT_HELD');
    }

    const payTo = normalizeAddress(requirement.payTo);
    if (!payTo) {
      codes.push('RECIPIENT_MALFORMED');
    } else if (policy.payTo && getAddress(policy.payTo) !== payTo) {
      codes.push('RECIPIENT_NOT_PINNED');
    }

    const amountAtomic = readAmount(requirement);
    if (amountAtomic === null) {
      codes.push('AMOUNT_MALFORMED');
    } else if (BigInt(amountAtomic) > BigInt(policy.maximumAtomicAmount)) {
      codes.push('AMOUNT_ABOVE_CEILING');
    }

    const transferMethod = readTransferMethod(requirement);
    if (transferMethod === null) {
      codes.push('TRANSFER_METHOD_UNSUPPORTED');
    } else if (!allowedMethods.includes(transferMethod)) {
      codes.push('TRANSFER_METHOD_NOT_ALLOWED');
    } else if (transferMethod === 'eip3009' && asset) {
      // Canonical BNB USDT and USDC are plain ERC-20s with no transferWithAuthorization. A target
      // advertising EIP-3009 over one of them is offering terms nothing can settle, and signing it
      // would burn the run on an authorization the token will reject.
      const info = bnbAssetInfo(asset);
      if (info && !info.supportsEip3009) codes.push('ASSET_DOES_NOT_SUPPORT_EIP3009');
    }

    if (codes.length > 0) {
      rejected.push({ index, codes });
      continue;
    }
    return {
      payable: {
        requirement,
        amountAtomic: amountAtomic as string,
        asset: asset as `0x${string}`,
        payTo: payTo as `0x${string}`,
        transferMethod: transferMethod as AssetTransferMethod,
      },
      rejected,
    };
  }

  return { rejected };
}

/**
 * Raised when nothing in a target's challenge is payable under the policy. Carries the per-entry
 * rejection codes so a caller can classify the outcome -- an asset we do not hold is an operator
 * configuration problem, a price above the ceiling is a budget decision, and a scheme we cannot
 * sign is a library limitation. A bare message would collapse all three into "payment failed".
 */
export class X402RequirementNotPayableError extends Error {
  readonly endpoint: string;
  readonly rejected: readonly RejectedRequirement[];
  /** Every distinct rejection code across all entries, for failure-code reporting. */
  readonly codes: readonly string[];

  constructor(endpoint: string, rejected: readonly RejectedRequirement[]) {
    super(`No payable x402 requirement at ${endpoint} (${describeRejections(rejected)})`);
    this.name = 'X402RequirementNotPayableError';
    this.endpoint = endpoint;
    this.rejected = rejected;
    this.codes = [...new Set(rejected.flatMap((entry) => entry.codes))];
  }
}

/** Formats a selection's rejections for an error message, keeping every reason rather than the first. */
export function describeRejections(rejected: readonly RejectedRequirement[]): string {
  if (rejected.length === 0) return 'the challenge offered no payment options';
  return rejected.map((entry) => `#${entry.index}: ${entry.codes.join(', ')}`).join('; ');
}

/** Reads the price from either x402 version: v2 calls it `amount`, v1 `maxAmountRequired`. */
function readAmount(requirement: PaymentRequirements): string | null {
  const raw =
    'amount' in requirement && typeof requirement.amount === 'string'
      ? requirement.amount
      : 'maxAmountRequired' in requirement && typeof requirement.maxAmountRequired === 'string'
        ? requirement.maxAmountRequired
        : null;
  return raw !== null && /^(0|[1-9]\d*)$/.test(raw) ? raw : null;
}

function readTransferMethod(requirement: PaymentRequirements): AssetTransferMethod | null {
  const extra = requirement.extra;
  const declared =
    extra && typeof extra === 'object' ? (extra as Record<string, unknown>)['assetTransferMethod'] : null;
  if (declared === undefined || declared === null) return DEFAULT_ASSET_TRANSFER_METHOD;
  return SUPPORTED_ASSET_TRANSFER_METHODS.find((method) => method === declared) ?? null;
}

function normalizeAddress(value: unknown): `0x${string}` | null {
  return typeof value === 'string' && isAddress(value) ? (getAddress(value) as `0x${string}`) : null;
}
