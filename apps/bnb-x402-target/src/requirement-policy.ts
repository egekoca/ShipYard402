import { getAddress, isAddress } from 'viem';

import { BNB_MAINNET_NETWORK } from './runtime-config.js';

export type ControlledRequirementPolicy = Readonly<{
  payTo: `0x${string}`;
  priceAtomic: string;
  /** The one settlement asset this target charges in -- anything else is rejected. */
  settlementAsset: `0x${string}`;
}>;

/** Restricts the private facilitator so it cannot relay arbitrary BNB token transfers. */
export function assertControlledBnbRequirement(value: unknown, policy: ControlledRequirementPolicy): void {
  if (!isRecord(value)) throw new Error('paymentRequirements must be an object');
  if (value['scheme'] !== 'exact') throw new Error('Only the exact x402 scheme is allowed');
  if (value['network'] !== BNB_MAINNET_NETWORK) throw new Error('Only BNB Mainnet x402 settlement is allowed');
  if (value['amount'] !== policy.priceAtomic)
    throw new Error('Payment amount does not match the controlled target price');
  if (!sameAddress(value['asset'], policy.settlementAsset))
    throw new Error('Payment asset does not match the controlled target settlement asset');
  if (!sameAddress(value['payTo'], policy.payTo))
    throw new Error('Payment recipient does not match the controlled target');
  const extra = value['extra'];
  if (!isRecord(extra) || extra['assetTransferMethod'] !== 'permit2') {
    throw new Error('Controlled BNB settlement requires Permit2');
  }
}

function sameAddress(value: unknown, expected: string): boolean {
  return typeof value === 'string' && isAddress(value) && getAddress(value) === getAddress(expected);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
