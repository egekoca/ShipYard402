import { Wallet, verifyTypedData } from 'ethers';
import { describe, expect, it } from 'vitest';

import type { RunAttestationInput } from './ports.js';
import { ATTESTATION_TYPED_DATA_TYPES, attestationTypedDataValue, registryDomain } from './registry-eip712.js';

const attestation: RunAttestationInput = {
  runId: `0x${'11'.repeat(32)}`,
  targetAgentId: 123456789n,
  targetServiceId: `0x${'22'.repeat(32)}`,
  targetVersionHash: `0x${'33'.repeat(32)}`,
  policyHash: `0x${'44'.repeat(32)}`,
  customerPaymentProofHash: `0x${'55'.repeat(32)}`,
  toolReceiptRoot: `0x${'66'.repeat(32)}`,
  evidenceRoot: `0x${'77'.repeat(32)}`,
  evidenceURI: 'https://api.example/v1/runs/run_1/evidence',
  requester: '0x2000000000000000000000000000000000000002',
  shipyardAgent: '0x8eb7E837242d6eE3Baa274F1750C644bF3E08c10',
  customerPaymentToken: '0x1000000000000000000000000000000000000001',
  toolSpendToken: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
  customerPayment: 1_000_000n,
  toolSpend: 500_000n,
  completedAt: 1_800_000_000,
  expiresAt: 1_802_592_000,
  result: 'PASS',
};

describe('registry EIP-712 attestation encoding', () => {
  it('round-trips through sign and verifyTypedData to the same signer address', async () => {
    const wallet = Wallet.createRandom();
    const chainId = 48816;
    const registryAddress = '0x07f6a55Fb88DD29e9A10802ce8d706dA26db8ddd' as const;
    const domain = registryDomain(chainId, registryAddress);
    const value = attestationTypedDataValue(attestation);

    const signature = await wallet.signTypedData(domain, ATTESTATION_TYPED_DATA_TYPES, value);
    const recovered = verifyTypedData(domain, ATTESTATION_TYPED_DATA_TYPES, value, signature);

    expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  it('produces a different digest when any field of the attestation changes', async () => {
    const wallet = Wallet.createRandom();
    const chainId = 48816;
    const registryAddress = '0x07f6a55Fb88DD29e9A10802ce8d706dA26db8ddd' as const;
    const domain = registryDomain(chainId, registryAddress);

    const valueA = attestationTypedDataValue(attestation);
    const valueB = attestationTypedDataValue({ ...attestation, result: 'FAIL' });

    const signatureA = await wallet.signTypedData(domain, ATTESTATION_TYPED_DATA_TYPES, valueA);
    expect(verifyTypedData(domain, ATTESTATION_TYPED_DATA_TYPES, valueB, signatureA).toLowerCase())
      .not.toBe(wallet.address.toLowerCase());
  });
});
