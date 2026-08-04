import {
  TypedDataEncoder,
  concat,
  getAddress,
  keccak256,
  verifyTypedData,
  type TypedDataDomain,
  type TypedDataField,
} from 'ethers';
import { z } from 'zod';

const bytes32Schema = z.string().regex(/^0x[a-fA-F0-9]{64}$/);
const transactionHashSchema = z.string().regex(/^0x[a-fA-F0-9]{64}$/);

export const toolReceiptSchema = z
  .object({
    receiptVersion: z.literal('1.0'),
    runId: z.string().min(1).max(200),
    toolAgentId: z.string().min(1).max(256),
    targetAgentId: z.string().min(1).max(256),
    targetVersionHash: bytes32Schema,
    policyHash: bytes32Schema,
    scenarioId: z.string().regex(/^[a-z0-9][a-z0-9_.-]{1,127}$/),
    requestHash: bytes32Schema,
    responseHash: bytes32Schema,
    paymentProofHash: bytes32Schema,
    chainTransactionHash: transactionHashSchema,
    chainId: z.number().int().positive(),
    startedAt: z.number().int().nonnegative(),
    completedAt: z.number().int().nonnegative(),
    result: z.enum(['PASS', 'FAIL', 'INCONCLUSIVE']),
    failureCode: z.string().max(128),
    toolVersion: z.string().min(1).max(100),
    signatureScheme: z.literal('EIP712'),
    signature: z.string().regex(/^0x[a-fA-F0-9]+$/),
  })
  .strict()
  .superRefine((receipt, context) => {
    if (receipt.completedAt < receipt.startedAt) {
      context.addIssue({ code: 'custom', path: ['completedAt'], message: 'Completion precedes start' });
    }
    if (receipt.result === 'PASS' && receipt.failureCode !== '') {
      context.addIssue({ code: 'custom', path: ['failureCode'], message: 'PASS cannot contain a failure code' });
    }
    if (receipt.result !== 'PASS' && receipt.failureCode.length === 0) {
      context.addIssue({ code: 'custom', path: ['failureCode'], message: 'Non-PASS receipts require a failure code' });
    }
  });

export type ToolReceipt = z.infer<typeof toolReceiptSchema>;
export type UnsignedToolReceipt = Omit<ToolReceipt, 'signature'>;

export const TOOL_RECEIPT_TYPES: Record<string, TypedDataField[]> = {
  ToolReceipt: [
    { name: 'receiptVersion', type: 'string' },
    { name: 'runId', type: 'string' },
    { name: 'toolAgentId', type: 'string' },
    { name: 'targetAgentId', type: 'string' },
    { name: 'targetVersionHash', type: 'bytes32' },
    { name: 'policyHash', type: 'bytes32' },
    { name: 'scenarioId', type: 'string' },
    { name: 'requestHash', type: 'bytes32' },
    { name: 'responseHash', type: 'bytes32' },
    { name: 'paymentProofHash', type: 'bytes32' },
    { name: 'chainTransactionHash', type: 'bytes32' },
    { name: 'chainId', type: 'uint256' },
    { name: 'startedAt', type: 'uint64' },
    { name: 'completedAt', type: 'uint64' },
    { name: 'result', type: 'string' },
    { name: 'failureCode', type: 'string' },
    { name: 'toolVersion', type: 'string' },
    { name: 'signatureScheme', type: 'string' },
  ],
};

export type ReceiptExpectation = Readonly<{
  providerSigner: `0x${string}`;
  runId: string;
  toolAgentId: string;
  targetAgentId: string;
  targetVersionHash: `0x${string}`;
  policyHash: `0x${string}`;
  scenarioId: string;
  chainId: number;
}>;

export type ReceiptVerification = Readonly<{
  valid: boolean;
  failureCodes: readonly string[];
  signer: `0x${string}` | null;
  receiptHash: `0x${string}` | null;
}>;

export function toolReceiptDomain(chainId: number): TypedDataDomain {
  return { name: 'Shipyard402ToolReceipt', version: '1', chainId };
}

export function unsignedReceiptValue(receipt: ToolReceipt | UnsignedToolReceipt): UnsignedToolReceipt {
  const { signature: _signature, ...unsigned } = receipt as ToolReceipt;
  return unsigned;
}

export function hashToolReceipt(receipt: ToolReceipt | UnsignedToolReceipt): `0x${string}` {
  const value = unsignedReceiptValue(receipt);
  return TypedDataEncoder.hash(toolReceiptDomain(value.chainId), TOOL_RECEIPT_TYPES, value) as `0x${string}`;
}

export function verifyToolReceipt(receiptInput: unknown, expected: ReceiptExpectation): ReceiptVerification {
  const parsed = toolReceiptSchema.safeParse(receiptInput);
  if (!parsed.success) {
    return { valid: false, failureCodes: ['RECEIPT_SCHEMA_INVALID'], signer: null, receiptHash: null };
  }

  const receipt = parsed.data;
  const failures: string[] = [];
  if (receipt.runId !== expected.runId) failures.push('RUN_ID_MISMATCH');
  if (receipt.toolAgentId !== expected.toolAgentId) failures.push('TOOL_AGENT_MISMATCH');
  if (receipt.targetAgentId !== expected.targetAgentId) failures.push('TARGET_AGENT_MISMATCH');
  if (receipt.targetVersionHash.toLowerCase() !== expected.targetVersionHash.toLowerCase()) {
    failures.push('TARGET_VERSION_MISMATCH');
  }
  if (receipt.policyHash.toLowerCase() !== expected.policyHash.toLowerCase()) failures.push('POLICY_MISMATCH');
  if (receipt.scenarioId !== expected.scenarioId) failures.push('SCENARIO_MISMATCH');
  if (receipt.chainId !== expected.chainId) failures.push('CHAIN_MISMATCH');

  let signer: `0x${string}` | null = null;
  try {
    signer = verifyTypedData(
      toolReceiptDomain(receipt.chainId),
      TOOL_RECEIPT_TYPES,
      unsignedReceiptValue(receipt),
      receipt.signature,
    ) as `0x${string}`;
    if (getAddress(signer) !== getAddress(expected.providerSigner)) failures.push('SIGNER_MISMATCH');
  } catch {
    failures.push('SIGNATURE_INVALID');
  }

  return {
    valid: failures.length === 0,
    failureCodes: [...new Set(failures)],
    signer,
    receiptHash: hashToolReceipt(receipt),
  };
}

export function buildToolReceiptRoot(receiptHashes: readonly `0x${string}`[]): `0x${string}` {
  if (receiptHashes.length === 0) throw new Error('At least one tool receipt hash is required');
  let level = [...receiptHashes].sort((left, right) => left.localeCompare(right));
  while (level.length > 1) {
    const next: `0x${string}`[] = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index]!;
      const right = level[index + 1] ?? left;
      next.push(keccak256(concat([left, right])) as `0x${string}`);
    }
    level = next;
  }
  return level[0]!;
}
