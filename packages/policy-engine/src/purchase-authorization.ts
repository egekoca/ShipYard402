import { isTerminalRunStatus, parseAtomicAmount, type RunStatus } from '@shipyard402/run-domain';

import { canonicalizeHost, type RunMandate } from './mandate.js';

export const PURCHASE_DENIAL_CODES = [
  'RUN_TERMINAL',
  'MANDATE_EXPIRED',
  'TOOL_NOT_ALLOWED',
  'HOST_NOT_ALLOWED',
  'SELF_DEALING_TOOL',
  'SELF_DEALING_HOST',
  'INVALID_AMOUNT',
  'SINGLE_PURCHASE_LIMIT',
  'TOTAL_SPEND_LIMIT',
  'TOOL_CALL_LIMIT',
  'RETRY_LIMIT',
  'ADDITIONAL_APPROVAL_REQUIRED',
  'INVALID_IDEMPOTENCY_KEY',
] as const;

export type PurchaseDenialCode = (typeof PURCHASE_DENIAL_CODES)[number];

export type PurchaseIntent = Readonly<{
  runId: string;
  toolAgentId: string;
  providerServiceId: string;
  host: string;
  atomicAmount: string;
  idempotencyKey: string;
}>;

export type PurchaseContext = Readonly<{
  nowEpochSeconds: number;
  runStatus: RunStatus;
  currentTotalSpend: string;
  completedToolCalls: number;
  priorAttemptsForTool: number;
  shipyardAgentId: string;
  shipyardControlledHosts: readonly string[];
  additionalSpendApproved: boolean;
}>;

export type PurchaseAuthorization = Readonly<{
  authorized: boolean;
  denialCodes: readonly PurchaseDenialCode[];
  projectedTotalSpend: string;
  audit: Readonly<{
    runId: string;
    toolAgentId: string;
    providerServiceId: string;
    host: string;
    atomicAmount: string;
    idempotencyKey: string;
    evaluatedAt: number;
  }>;
}>;

export function authorizePurchase(
  mandate: RunMandate,
  intent: PurchaseIntent,
  context: PurchaseContext,
): PurchaseAuthorization {
  const denialCodes: PurchaseDenialCode[] = [];
  const currentSpend = parseAtomicAmount(context.currentTotalSpend);
  let amount = 0n;

  try {
    amount = parseAtomicAmount(intent.atomicAmount);
    if (amount === 0n) denialCodes.push('INVALID_AMOUNT');
  } catch {
    denialCodes.push('INVALID_AMOUNT');
  }

  const projectedTotalSpend = currentSpend + amount;
  let host = intent.host;
  try {
    host = canonicalizeHost(intent.host);
  } catch {
    denialCodes.push('HOST_NOT_ALLOWED');
  }

  if (isTerminalRunStatus(context.runStatus)) denialCodes.push('RUN_TERMINAL');
  if (context.nowEpochSeconds > mandate.deadline) denialCodes.push('MANDATE_EXPIRED');
  if (!mandate.allowedToolAgentIds.includes(intent.toolAgentId)) denialCodes.push('TOOL_NOT_ALLOWED');
  if (!mandate.allowedHosts.includes(host)) denialCodes.push('HOST_NOT_ALLOWED');
  if (intent.toolAgentId === context.shipyardAgentId) denialCodes.push('SELF_DEALING_TOOL');

  const controlledHosts = context.shipyardControlledHosts.map((value) => canonicalizeHost(value));
  if (controlledHosts.includes(host)) denialCodes.push('SELF_DEALING_HOST');
  if (amount > BigInt(mandate.maximumSinglePurchase)) denialCodes.push('SINGLE_PURCHASE_LIMIT');
  if (projectedTotalSpend > BigInt(mandate.maximumTotalSpend)) denialCodes.push('TOTAL_SPEND_LIMIT');
  if (context.completedToolCalls >= mandate.maximumToolCalls) denialCodes.push('TOOL_CALL_LIMIT');
  if (context.priorAttemptsForTool > mandate.maximumRetriesPerTool) denialCodes.push('RETRY_LIMIT');
  if (
    projectedTotalSpend > BigInt(mandate.additionalSpendApprovalThreshold) &&
    !context.additionalSpendApproved
  ) {
    denialCodes.push('ADDITIONAL_APPROVAL_REQUIRED');
  }
  if (intent.idempotencyKey.length < 16 || intent.idempotencyKey.length > 200) {
    denialCodes.push('INVALID_IDEMPOTENCY_KEY');
  }

  return {
    authorized: denialCodes.length === 0,
    denialCodes: [...new Set(denialCodes)],
    projectedTotalSpend: projectedTotalSpend.toString(),
    audit: {
      runId: intent.runId,
      toolAgentId: intent.toolAgentId,
      providerServiceId: intent.providerServiceId,
      host,
      atomicAmount: intent.atomicAmount,
      idempotencyKey: intent.idempotencyKey,
      evaluatedAt: context.nowEpochSeconds,
    },
  };
}
