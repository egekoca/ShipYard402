import { Interface, getAddress, id, zeroPadValue, toBeHex } from 'ethers';

import type { GoatFlowOrderStatus, MerchantOrder, MerchantPaymentProof } from './ports.js';

const transferInterface = new Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);

const TRANSFER_TOPIC = id('Transfer(address,address,uint256)');
const SUCCESSFUL_ORDER_STATUSES = new Set<GoatFlowOrderStatus>(['PAYMENT_CONFIRMED', 'INVOICED']);

export type NormalizedTransactionReceipt = Readonly<{
  chainId: number;
  transactionHash: `0x${string}`;
  status: 0 | 1;
  logs: readonly Readonly<{
    address: `0x${string}`;
    topics: readonly string[];
    data: string;
    index: number;
  }>[];
}>;

export type SettlementExpectation = Readonly<{
  chainId: number;
  tokenAddress: `0x${string}`;
  payerAddress: `0x${string}`;
  recipientAddress: `0x${string}`;
  atomicAmount: string;
  orderId: string;
}>;

export type SettlementVerification = Readonly<{
  valid: boolean;
  failureCodes: readonly string[];
  paymentProofHashMaterial: string;
}>;

export function verifySettlement(
  order: MerchantOrder,
  proof: MerchantPaymentProof,
  receipt: NormalizedTransactionReceipt,
  expected: SettlementExpectation,
): SettlementVerification {
  const failures: string[] = [];
  if (!SUCCESSFUL_ORDER_STATUSES.has(order.status)) failures.push('ORDER_NOT_CONFIRMED');
  if (order.orderId !== expected.orderId || proof.orderId !== expected.orderId) failures.push('ORDER_MISMATCH');
  if (
    order.chainId !== expected.chainId ||
    proof.chainId !== expected.chainId ||
    receipt.chainId !== expected.chainId
  ) {
    failures.push('CHAIN_MISMATCH');
  }
  if (!sameAddress(order.tokenAddress, expected.tokenAddress)) failures.push('TOKEN_MISMATCH');
  if (
    !sameAddress(order.payerAddress, expected.payerAddress) ||
    !sameAddress(proof.fromAddress, expected.payerAddress)
  ) {
    failures.push('PAYER_MISMATCH');
  }
  if (
    !sameAddress(order.payToAddress, expected.recipientAddress) ||
    !sameAddress(proof.toAddress, expected.recipientAddress)
  ) {
    failures.push('RECIPIENT_MISMATCH');
  }
  if (order.atomicAmount !== expected.atomicAmount || proof.atomicAmount !== expected.atomicAmount) {
    failures.push('AMOUNT_MISMATCH');
  }
  if (receipt.status !== 1) failures.push('TRANSACTION_REVERTED');
  if (receipt.transactionHash.toLowerCase() !== proof.transactionHash.toLowerCase()) {
    failures.push('TRANSACTION_HASH_MISMATCH');
  }

  const log = receipt.logs.find((candidate) => candidate.index === proof.logIndex);
  if (!log) {
    failures.push('TRANSFER_LOG_MISSING');
  } else if (!matchesTransferLog(log, expected)) {
    failures.push('TRANSFER_LOG_MISMATCH');
  }

  return {
    valid: failures.length === 0,
    failureCodes: [...new Set(failures)],
    paymentProofHashMaterial: [
      expected.chainId,
      proof.transactionHash.toLowerCase(),
      proof.logIndex,
      expected.orderId,
    ].join(':'),
  };
}
function matchesTransferLog(
  log: NormalizedTransactionReceipt['logs'][number],
  expected: SettlementExpectation,
): boolean {
  if (!sameAddress(log.address, expected.tokenAddress) || log.topics[0] !== TRANSFER_TOPIC) return false;
  try {
    const parsed = transferInterface.parseLog({ topics: [...log.topics], data: log.data });
    if (!parsed) return false;
    return (
      sameAddress(String(parsed.args['from']), expected.payerAddress) &&
      sameAddress(String(parsed.args['to']), expected.recipientAddress) &&
      BigInt(parsed.args['value']) === BigInt(expected.atomicAmount)
    );
  } catch {
    return false;
  }
}

function sameAddress(left: string, right: string): boolean {
  try {
    return getAddress(left) === getAddress(right);
  } catch {
    return false;
  }
}

export function encodeTransferLog(
  token: `0x${string}`,
  from: `0x${string}`,
  to: `0x${string}`,
  atomicAmount: string,
  index: number,
): NormalizedTransactionReceipt['logs'][number] {
  return {
    address: token,
    topics: [TRANSFER_TOPIC, zeroPadValue(from, 32), zeroPadValue(to, 32)],
    data: zeroPadValue(toBeHex(BigInt(atomicAmount)), 32),
    index,
  };
}
