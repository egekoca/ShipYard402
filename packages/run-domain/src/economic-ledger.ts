import { assertSameAsset, parseAtomicAmount, type AssetId } from './money.js';

export const LEDGER_CATEGORIES = [
  'CUSTOMER_PAYMENT',
  'CUSTOMER_REFUND',
  'TOOL_SPEND',
  'MODEL_COST',
  'CHAIN_COST',
  'STORAGE_COST',
] as const;

export type LedgerCategory = (typeof LEDGER_CATEGORIES)[number];

export type LedgerEntry = Readonly<{
  id: string;
  runId: string;
  category: LedgerCategory;
  asset: AssetId;
  atomicAmount: string;
  accountingValueMicros?: string;
  accountingCurrency?: 'USD';
  transactionHash?: `0x${string}`;
  externalReference?: string;
  occurredAt: string;
}>;

export type RunEconomics = Readonly<{
  customerRevenueMicros: string;
  customerRefundMicros: string;
  toolCostMicros: string;
  modelCostMicros: string;
  chainCostMicros: string;
  storageCostMicros: string;
  grossContributionMicros: string;
}>;

export function calculateRunEconomics(entries: readonly LedgerEntry[]): RunEconomics {
  const total = (category: LedgerCategory): bigint =>
    entries
      .filter((entry) => entry.category === category)
      .reduce((sum, entry) => {
        if (entry.accountingCurrency !== 'USD' || entry.accountingValueMicros === undefined) {
          throw new Error(`Ledger entry ${entry.id} lacks an explicit USD micro valuation`);
        }
        return sum + parseAtomicAmount(entry.accountingValueMicros);
      }, 0n);

  const customerRevenue = total('CUSTOMER_PAYMENT');
  const customerRefund = total('CUSTOMER_REFUND');
  const toolCost = total('TOOL_SPEND');
  const modelCost = total('MODEL_COST');
  const chainCost = total('CHAIN_COST');
  const storageCost = total('STORAGE_COST');

  return {
    customerRevenueMicros: customerRevenue.toString(),
    customerRefundMicros: customerRefund.toString(),
    toolCostMicros: toolCost.toString(),
    modelCostMicros: modelCost.toString(),
    chainCostMicros: chainCost.toString(),
    storageCostMicros: storageCost.toString(),
    grossContributionMicros: (
      customerRevenue -
      customerRefund -
      toolCost -
      modelCost -
      chainCost -
      storageCost
    ).toString(),
  };
}
export function calculateAssetPosition(entries: readonly LedgerEntry[], asset: AssetId): bigint {
  return entries.reduce((position, entry) => {
    try {
      assertSameAsset(entry.asset, asset);
    } catch {
      return position;
    }
    const amount = parseAtomicAmount(entry.atomicAmount);
    return entry.category === 'CUSTOMER_PAYMENT' ? position + amount : position - amount;
  }, 0n);
}
