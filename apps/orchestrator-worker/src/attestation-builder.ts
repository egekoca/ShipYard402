import { keccak256, toUtf8Bytes } from 'ethers';

import type { RunAttestationInput } from './ports.js';

/** Sentinel used by many EVM protocols to represent the native asset where an ERC-20 address is expected. */
export const NATIVE_ASSET_SENTINEL = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' as const;

const EXPIRY_WINDOW_SECONDS = 30 * 24 * 60 * 60;

export type AttestationInputParams = Readonly<{
  runId: string;
  targetAgentId: string;
  targetServiceId: string;
  targetVersionHash: `0x${string}`;
  policyHash: `0x${string}`;
  customerPaymentProofHash: `0x${string}`;
  toolReceiptRoot: `0x${string}`;
  evidenceRoot: `0x${string}`;
  evidenceURI: string;
  requester: `0x${string}`;
  shipyardAgent: `0x${string}`;
  customerPaymentToken: `0x${string}`;
  toolSpendAtomic: bigint;
  customerPaymentAtomic: bigint;
  completedAt: number;
  result: 'PASS' | 'CONDITIONAL' | 'FAIL' | 'INCONCLUSIVE';
}>;

/**
 * ERC-8004 identity integration is not wired in yet (docs/architecture.md). Until then, on-chain
 * numeric/bytes32 identifiers are deterministic hashes of the off-chain string identifiers, not
 * real registry ids.
 */
export function buildAttestationInput(params: AttestationInputParams): RunAttestationInput {
  return {
    runId: keccak256(toUtf8Bytes(params.runId)) as `0x${string}`,
    targetAgentId: BigInt(keccak256(toUtf8Bytes(params.targetAgentId))),
    targetServiceId: keccak256(toUtf8Bytes(params.targetServiceId)) as `0x${string}`,
    targetVersionHash: params.targetVersionHash,
    policyHash: params.policyHash,
    customerPaymentProofHash: params.customerPaymentProofHash,
    toolReceiptRoot: params.toolReceiptRoot,
    evidenceRoot: params.evidenceRoot,
    evidenceURI: params.evidenceURI,
    requester: params.requester,
    shipyardAgent: params.shipyardAgent,
    customerPaymentToken: params.customerPaymentToken,
    toolSpendToken: params.toolSpendAtomic > 0n ? NATIVE_ASSET_SENTINEL : '0x0000000000000000000000000000000000000000',
    customerPayment: params.customerPaymentAtomic,
    toolSpend: params.toolSpendAtomic,
    completedAt: params.completedAt,
    expiresAt: params.completedAt + EXPIRY_WINDOW_SECONDS,
    result: params.result,
  };
}
