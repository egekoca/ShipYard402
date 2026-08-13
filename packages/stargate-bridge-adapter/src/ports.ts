import type { BridgeQuote, CrossChainProcurementIntent, EvmAddress, TransactionHash } from '@shipyard402/x402-payments';

export type StargateSendParameters = Readonly<{
  destinationEndpointId: number;
  destinationRecipient: EvmAddress;
  amountInAtomic: string;
  minimumAmountOutAtomic: string;
}>;

export interface StargateSourceChainPort {
  quoteOft(
    input: StargateSendParameters,
    signal?: AbortSignal,
  ): Promise<
    Readonly<{
      /** Source-token local decimals, as returned by quoteOFT on the source chain. */
      amountSentAtomic: string;
      /** Source-token local decimals; the adapter converts through Stargate shared decimals. */
      amountReceivedAtomic: string;
    }>
  >;
  quoteSend(input: StargateSendParameters, signal?: AbortSignal): Promise<Readonly<{ nativeFeeWei: string }>>;
  ensureTokenAllowance(amountAtomic: string, signal?: AbortSignal): Promise<void>;
  send(
    input: StargateSendParameters & Readonly<{ nativeFeeWei: string }>,
    signal?: AbortSignal,
  ): Promise<Readonly<{ transactionHash: TransactionHash }>>;
}

export type LayerZeroDelivery = Readonly<{
  status: string;
  destinationStatus?: string;
  destinationTransactionHash?: TransactionHash;
  failureReason?: string;
}>;

export interface LayerZeroScanPort {
  getDelivery(sourceTransactionHash: TransactionHash, signal?: AbortSignal): Promise<LayerZeroDelivery | null>;
}

export interface DestinationReceiptPort {
  getTokenAmountReceived(
    input: Readonly<{
      transactionHash: TransactionHash;
      tokenAddress: EvmAddress;
      recipientAddress: EvmAddress;
    }>,
    signal?: AbortSignal,
  ): Promise<string | null>;
}

export type BridgeSubmissionRecord = Readonly<{
  status: 'CLAIMED' | 'SUBMITTED';
  idempotencyKey: string;
  quoteId: string;
  runId: string;
  destinationPayerAddress: EvmAddress;
  minimumAmountOutAtomic: string;
  sourceTransactionHash?: TransactionHash;
  transferId?: string;
}>;

export interface BridgeSubmissionStore {
  claim(record: BridgeSubmissionRecord): Promise<Readonly<{ acquired: boolean; record: BridgeSubmissionRecord }>>;
  markSubmitted(
    idempotencyKey: string,
    result: Readonly<{ sourceTransactionHash: TransactionHash; transferId: string }>,
  ): Promise<BridgeSubmissionRecord>;
  abandonClaim(idempotencyKey: string): Promise<void>;
  findByTransferId(transferId: string): Promise<BridgeSubmissionRecord | null>;
}

export class InMemoryBridgeSubmissionStore implements BridgeSubmissionStore {
  readonly #byIdempotencyKey = new Map<string, BridgeSubmissionRecord>();

  async claim(
    record: BridgeSubmissionRecord,
  ): Promise<Readonly<{ acquired: boolean; record: BridgeSubmissionRecord }>> {
    const existing = this.#byIdempotencyKey.get(record.idempotencyKey);
    if (existing) return { acquired: false, record: existing };
    this.#byIdempotencyKey.set(record.idempotencyKey, record);
    return { acquired: true, record };
  }

  async markSubmitted(
    idempotencyKey: string,
    result: Readonly<{ sourceTransactionHash: TransactionHash; transferId: string }>,
  ): Promise<BridgeSubmissionRecord> {
    const existing = this.#byIdempotencyKey.get(idempotencyKey);
    if (!existing) throw new Error('Bridge idempotency claim does not exist');
    const submitted: BridgeSubmissionRecord = { ...existing, ...result, status: 'SUBMITTED' };
    this.#byIdempotencyKey.set(idempotencyKey, submitted);
    return submitted;
  }

  async abandonClaim(idempotencyKey: string): Promise<void> {
    const existing = this.#byIdempotencyKey.get(idempotencyKey);
    if (existing?.status === 'CLAIMED') this.#byIdempotencyKey.delete(idempotencyKey);
  }

  async findByTransferId(transferId: string): Promise<BridgeSubmissionRecord | null> {
    for (const record of this.#byIdempotencyKey.values()) {
      if (record.transferId === transferId) return record;
    }
    return null;
  }
}

export type StargateBridgeAdapterInput = Readonly<{
  intent: CrossChainProcurementIntent;
  quote: BridgeQuote;
  idempotencyKey: string;
}>;
