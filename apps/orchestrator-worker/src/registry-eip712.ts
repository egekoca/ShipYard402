import { AbiCoder, keccak256, toUtf8Bytes, TypedDataEncoder, type TypedDataDomain, type TypedDataField } from 'ethers';

import type { RunAttestationInput } from './ports.js';

/**
 * Mirrors ShipyardRunRegistry.sol's hashAttestation exactly: the contract does not use standard
 * nested EIP-712 struct encoding for RunAttestation. It manually hashes four sub-structs
 * (RunScope/RunEvidence/RunEconomics/RunOutcome) via abi.encode(TYPEHASH, fields...), then treats
 * those four hashes as flat bytes32 leaves of the outer RunAttestation type. Signing this with a
 * naive nested-struct type definition would produce a different (invalid) digest.
 */
const RUN_SCOPE_TYPEHASH = keccak256(toUtf8Bytes(
  'RunScope(bytes32 runId,uint256 targetAgentId,bytes32 targetServiceId,bytes32 targetVersionHash,bytes32 policyHash,address requester,address shipyardAgent)',
));
const RUN_EVIDENCE_TYPEHASH = keccak256(toUtf8Bytes(
  'RunEvidence(bytes32 customerPaymentProofHash,bytes32 toolReceiptRoot,bytes32 evidenceRoot,bytes32 evidenceURIHash)',
));
const RUN_ECONOMICS_TYPEHASH = keccak256(toUtf8Bytes(
  'RunEconomics(address customerPaymentToken,address toolSpendToken,uint128 customerPayment,uint128 toolSpend)',
));
const RUN_OUTCOME_TYPEHASH = keccak256(toUtf8Bytes(
  'RunOutcome(uint64 completedAt,uint64 expiresAt,uint8 result)',
));

const RESULT_INDEX: Record<RunAttestationInput['result'], number> = {
  PASS: 0,
  CONDITIONAL: 1,
  FAIL: 2,
  INCONCLUSIVE: 3,
};

const coder = AbiCoder.defaultAbiCoder();

export function registryDomain(chainId: number, registryAddress: `0x${string}`): TypedDataDomain {
  return { name: 'ShipyardRunRegistry', version: '1', chainId, verifyingContract: registryAddress };
}

export function attestationTypedDataValue(attestation: RunAttestationInput): Readonly<{
  scopeHash: `0x${string}`;
  evidenceHash: `0x${string}`;
  economicsHash: `0x${string}`;
  outcomeHash: `0x${string}`;
}> {
  const scopeHash = keccak256(coder.encode(
    ['bytes32', 'bytes32', 'uint256', 'bytes32', 'bytes32', 'bytes32', 'address', 'address'],
    [
      RUN_SCOPE_TYPEHASH, attestation.runId, attestation.targetAgentId, attestation.targetServiceId,
      attestation.targetVersionHash, attestation.policyHash, attestation.requester, attestation.shipyardAgent,
    ],
  )) as `0x${string}`;

  const evidenceHash = keccak256(coder.encode(
    ['bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32'],
    [
      RUN_EVIDENCE_TYPEHASH, attestation.customerPaymentProofHash, attestation.toolReceiptRoot,
      attestation.evidenceRoot, keccak256(toUtf8Bytes(attestation.evidenceURI)),
    ],
  )) as `0x${string}`;

  const economicsHash = keccak256(coder.encode(
    ['bytes32', 'address', 'address', 'uint128', 'uint128'],
    [RUN_ECONOMICS_TYPEHASH, attestation.customerPaymentToken, attestation.toolSpendToken, attestation.customerPayment, attestation.toolSpend],
  )) as `0x${string}`;

  const outcomeHash = keccak256(coder.encode(
    ['bytes32', 'uint64', 'uint64', 'uint8'],
    [RUN_OUTCOME_TYPEHASH, attestation.completedAt, attestation.expiresAt, RESULT_INDEX[attestation.result]],
  )) as `0x${string}`;

  return { scopeHash, evidenceHash, economicsHash, outcomeHash };
}

export const ATTESTATION_TYPED_DATA_TYPES: Record<string, TypedDataField[]> = {
  RunAttestation: [
    { name: 'scopeHash', type: 'bytes32' },
    { name: 'evidenceHash', type: 'bytes32' },
    { name: 'economicsHash', type: 'bytes32' },
    { name: 'outcomeHash', type: 'bytes32' },
  ],
};

export function hashAttestation(chainId: number, registryAddress: `0x${string}`, attestation: RunAttestationInput): `0x${string}` {
  return TypedDataEncoder.hash(
    registryDomain(chainId, registryAddress),
    ATTESTATION_TYPED_DATA_TYPES,
    attestationTypedDataValue(attestation),
  ) as `0x${string}`;
}
