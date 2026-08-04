import { Wallet } from 'ethers';
import { describe, expect, it } from 'vitest';

import {
  TOOL_RECEIPT_TYPES,
  buildToolReceiptRoot,
  hashToolReceipt,
  toolReceiptDomain,
  unsignedReceiptValue,
  verifyToolReceipt,
  type ToolReceipt,
} from './tool-receipt.js';

const wallet = Wallet.createRandom();
const unsigned = {
  receiptVersion: '1.0',
  runId: 'run_001',
  toolAgentId: 'agent:tool:184',
  targetAgentId: 'agent:target:77',
  targetVersionHash: `0x${'11'.repeat(32)}`,
  policyHash: `0x${'22'.repeat(32)}`,
  scenarioId: 'payment_replay',
  requestHash: `0x${'33'.repeat(32)}`,
  responseHash: `0x${'44'.repeat(32)}`,
  paymentProofHash: `0x${'55'.repeat(32)}`,
  chainTransactionHash: `0x${'66'.repeat(32)}`,
  chainId: 2345,
  startedAt: 1_800_000_000,
  completedAt: 1_800_000_010,
  result: 'FAIL',
  failureCode: 'PAYMENT_PROOF_REPLAY_ACCEPTED',
  toolVersion: '1.0.0',
  signatureScheme: 'EIP712',
} as const;

async function signedReceipt(): Promise<ToolReceipt> {
  const signature = await wallet.signTypedData(toolReceiptDomain(2345), TOOL_RECEIPT_TYPES, unsigned);
  return { ...unsigned, signature };
}

const expectation = {
  providerSigner: wallet.address as `0x${string}`,
  runId: unsigned.runId,
  toolAgentId: unsigned.toolAgentId,
  targetAgentId: unsigned.targetAgentId,
  targetVersionHash: unsigned.targetVersionHash,
  policyHash: unsigned.policyHash,
  scenarioId: unsigned.scenarioId,
  chainId: 2345,
} as const;

describe('signed tool receipts', () => {
  it('verifies EIP-712 signer and all run bindings', async () => {
    const receipt = await signedReceipt();
    const result = verifyToolReceipt(receipt, expectation);
    expect(result.valid).toBe(true);
    expect(result.signer).toBe(wallet.address);
  });

  it('detects version-bound evidence tampering', async () => {
    const receipt = await signedReceipt();
    const tampered = { ...receipt, targetVersionHash: `0x${'99'.repeat(32)}` };
    const result = verifyToolReceipt(tampered, expectation);
    expect(result.valid).toBe(false);
    expect(result.failureCodes).toEqual(expect.arrayContaining(['TARGET_VERSION_MISMATCH', 'SIGNER_MISMATCH']));
  });

  it('builds an order-independent deterministic Merkle root', async () => {
    const first = await signedReceipt();
    const second = { ...first, scenarioId: 'idempotency' };
    const secondSignature = await wallet.signTypedData(
      toolReceiptDomain(2345),
      TOOL_RECEIPT_TYPES,
      unsignedReceiptValue(second),
    );
    const secondSigned = { ...second, signature: secondSignature };
    const firstHash = hashToolReceipt(first);
    const secondHash = hashToolReceipt(secondSigned);
    expect(buildToolReceiptRoot([firstHash, secondHash])).toBe(buildToolReceiptRoot([secondHash, firstHash]));
  });
});
