import { keccak256, toUtf8Bytes } from 'ethers';

import {
  assertBridgeQuotePayable,
  type BridgeQuote,
  type CrossChainBridgePort,
  type CrossChainProcurementIntent,
  type EvmAddress,
  type TransactionHash,
} from '@shipyard402/x402-payments';

import type {
  BridgeSubmissionRecord,
  BridgeSubmissionStore,
  DestinationReceiptPort,
  LayerZeroScanPort,
  StargateSendParameters,
  StargateSourceChainPort,
} from './ports.js';
import { GOAT_TO_BNB_USDT_STARGATE_ROUTE, type StargateRoute } from './route.js';

export const STARGATE_V2_PROVIDER = 'STARGATE_V2_LAYERZERO';

export type StargateBridgeAdapterOptions = Readonly<{
  sourceChain: StargateSourceChainPort;
  layerZeroScan: LayerZeroScanPort;
  destinationReceipts: DestinationReceiptPort;
  submissionStore: BridgeSubmissionStore;
  route?: StargateRoute;
  clock?: () => Date;
  quoteTtlMilliseconds?: number;
  maxNativeFeeWei: string;
}>;

export class StargateBridgeAdapter implements CrossChainBridgePort {
  readonly #sourceChain: StargateSourceChainPort;
  readonly #layerZeroScan: LayerZeroScanPort;
  readonly #destinationReceipts: DestinationReceiptPort;
  readonly #submissionStore: BridgeSubmissionStore;
  readonly #route: StargateRoute;
  readonly #clock: () => Date;
  readonly #quoteTtlMilliseconds: number;
  readonly #maxNativeFeeWei: bigint;

  constructor(options: StargateBridgeAdapterOptions) {
    this.#sourceChain = options.sourceChain;
    this.#layerZeroScan = options.layerZeroScan;
    this.#destinationReceipts = options.destinationReceipts;
    this.#submissionStore = options.submissionStore;
    this.#route = options.route ?? GOAT_TO_BNB_USDT_STARGATE_ROUTE;
    this.#clock = options.clock ?? (() => new Date());
    this.#quoteTtlMilliseconds = options.quoteTtlMilliseconds ?? 60_000;
    this.#maxNativeFeeWei = positiveBigInt(options.maxNativeFeeWei, 'maxNativeFeeWei');
    if (!Number.isInteger(this.#quoteTtlMilliseconds) || this.#quoteTtlMilliseconds <= 0) {
      throw new Error('quoteTtlMilliseconds must be a positive integer');
    }
  }

  async quote(intent: CrossChainProcurementIntent, signal?: AbortSignal): Promise<BridgeQuote> {
    this.#assertIntentRoute(intent);
    throwIfAborted(signal);
    const sendParameters = this.#sendParameters(intent, intent.funding.maximumAtomicAmount);
    const [oftQuote, messagingFee] = await Promise.all([
      this.#sourceChain.quoteOft(sendParameters, signal),
      this.#sourceChain.quoteSend(sendParameters, signal),
    ]);
    assertAtomic(oftQuote.amountSentAtomic, 'quoteOft.amountSentAtomic', false);
    assertAtomic(oftQuote.amountReceivedAtomic, 'quoteOft.amountReceivedAtomic', false);
    assertAtomic(messagingFee.nativeFeeWei, 'quoteSend.nativeFeeWei', true);
    const destinationAmountOutAtomic = this.#sourceToDestinationAtomic(oftQuote.amountReceivedAtomic);
    if (BigInt(destinationAmountOutAtomic) < BigInt(intent.target.maximumAtomicAmount)) {
      throw new Error('Stargate quoted output cannot cover the BNB x402 payment ceiling');
    }
    if (BigInt(messagingFee.nativeFeeWei) > this.#maxNativeFeeWei) {
      throw new Error('Stargate native messaging fee exceeds the configured safety ceiling');
    }

    const now = this.#clock();
    const intentExpiry = Date.parse(intent.expiresAt);
    const expiresAtMs = Math.min(now.getTime() + this.#quoteTtlMilliseconds, intentExpiry);
    if (expiresAtMs <= now.getTime()) throw new Error('Cross-chain procurement intent has expired');
    const expiresAt = new Date(expiresAtMs).toISOString();
    const feeAtomic = (BigInt(sendParameters.amountInAtomic) - BigInt(oftQuote.amountReceivedAtomic)).toString();
    if (BigInt(feeAtomic) < 0n) throw new Error('Stargate returned an invalid output greater than its input');

    const providerData = Object.freeze({
      routeId: this.#route.id,
      sourceOftAddress: this.#route.sourceOftAddress,
      destinationOftAddress: this.#route.destinationOftAddress,
      destinationEndpointId: String(this.#route.destinationEndpointId),
      destinationPayerAddress: intent.target.payerAddress,
      quotedAmountOutAtomic: destinationAmountOutAtomic,
      nativeFeeWei: messagingFee.nativeFeeWei,
    });
    const quoteId = keccak256(
      toUtf8Bytes(
        [
          intent.runId,
          sendParameters.amountInAtomic,
          intent.target.maximumAtomicAmount,
          messagingFee.nativeFeeWei,
          expiresAt,
        ].join(':'),
      ),
    );

    return Object.freeze({
      quoteId,
      provider: STARGATE_V2_PROVIDER,
      sourceAsset: this.#route.sourceAsset,
      destinationAsset: this.#route.destinationAsset,
      amountInAtomic: sendParameters.amountInAtomic,
      minimumAmountOutAtomic: intent.target.maximumAtomicAmount,
      feeAtomic,
      expiresAt,
      providerData,
    });
  }

  async submit(
    input: Readonly<{ intent: CrossChainProcurementIntent; quote: BridgeQuote; idempotencyKey: string }>,
    signal?: AbortSignal,
  ): Promise<Readonly<{ transferId: string; sourceTransactionHash: TransactionHash }>> {
    this.#assertIntentRoute(input.intent);
    assertNonEmpty(input.idempotencyKey, 'idempotencyKey');
    assertBridgeQuotePayable(input.intent, input.quote, this.#clock());
    this.#assertQuoteRoute(input.intent, input.quote);

    const claimedRecord: BridgeSubmissionRecord = {
      status: 'CLAIMED',
      idempotencyKey: input.idempotencyKey,
      quoteId: input.quote.quoteId,
      runId: input.intent.runId,
      destinationPayerAddress: input.intent.target.payerAddress,
      minimumAmountOutAtomic: input.quote.minimumAmountOutAtomic,
    };
    const claim = await this.#submissionStore.claim(claimedRecord);
    if (!claim.acquired) {
      if (
        claim.record.status === 'SUBMITTED' &&
        claim.record.sourceTransactionHash !== undefined &&
        claim.record.transferId !== undefined
      ) {
        return {
          sourceTransactionHash: claim.record.sourceTransactionHash,
          transferId: claim.record.transferId,
        };
      }
      throw new Error('Bridge submission with this idempotency key is already being reconciled');
    }

    let sendAttempted = false;
    try {
      throwIfAborted(signal);
      const sendParameters = this.#sendParameters(input.intent, input.quote.amountInAtomic);
      const [freshOftQuote, freshMessagingFee] = await Promise.all([
        this.#sourceChain.quoteOft(sendParameters, signal),
        this.#sourceChain.quoteSend(sendParameters, signal),
      ]);
      assertAtomic(freshOftQuote.amountReceivedAtomic, 'freshQuote.amountReceivedAtomic', false);
      assertAtomic(freshMessagingFee.nativeFeeWei, 'freshQuote.nativeFeeWei', true);
      const freshDestinationAmountOutAtomic = this.#sourceToDestinationAtomic(freshOftQuote.amountReceivedAtomic);
      if (BigInt(freshDestinationAmountOutAtomic) < BigInt(input.quote.minimumAmountOutAtomic)) {
        throw new Error('Fresh Stargate output fell below the authorized minimum');
      }
      if (BigInt(freshMessagingFee.nativeFeeWei) > this.#maxNativeFeeWei) {
        throw new Error('Fresh Stargate native messaging fee exceeds the configured safety ceiling');
      }

      await this.#sourceChain.ensureTokenAllowance(input.quote.amountInAtomic, signal);
      // From this point forward an RPC error is ambiguous: the transaction may have reached the
      // node even if its hash never reached this process. Keep the CLAIMED row so a retry fails
      // closed and requires reconciliation instead of broadcasting a second bridge transfer.
      sendAttempted = true;
      const submitted = await this.#sourceChain.send(
        { ...sendParameters, nativeFeeWei: freshMessagingFee.nativeFeeWei },
        signal,
      );
      assertHash(submitted.transactionHash, 'sourceTransactionHash');
      const transferId = submitted.transactionHash;
      await this.#submissionStore.markSubmitted(input.idempotencyKey, {
        sourceTransactionHash: submitted.transactionHash,
        transferId,
      });
      return { sourceTransactionHash: submitted.transactionHash, transferId };
    } catch (error) {
      if (!sendAttempted) await this.#submissionStore.abandonClaim(input.idempotencyKey);
      throw error;
    }
  }

  async getStatus(
    transferId: string,
    signal?: AbortSignal,
  ): Promise<
    Readonly<{
      status: 'PENDING' | 'DESTINATION_FUNDED' | 'FAILED' | 'REFUNDED';
      destinationTransactionHash?: TransactionHash;
      amountReceivedAtomic?: string;
      failureReason?: string;
    }>
  > {
    assertHash(transferId, 'transferId');
    const record = await this.#submissionStore.findByTransferId(transferId);
    if (record?.status !== 'SUBMITTED' || !record.sourceTransactionHash) {
      throw new Error('Unknown Stargate bridge transfer');
    }
    const delivery = await this.#layerZeroScan.getDelivery(record.sourceTransactionHash, signal);
    if (!delivery) return { status: 'PENDING' };
    const status = delivery.status.toUpperCase();
    const destinationStatus = delivery.destinationStatus?.toUpperCase();
    if (FAILURE_STATUSES.has(status) || (destinationStatus !== undefined && FAILURE_STATUSES.has(destinationStatus))) {
      return {
        status: 'FAILED',
        failureReason: delivery.failureReason ?? `LayerZero delivery failed with status ${status}`,
      };
    }
    if (status !== 'DELIVERED' || destinationStatus !== 'SUCCEEDED' || !delivery.destinationTransactionHash) {
      return { status: 'PENDING' };
    }
    const amountReceivedAtomic = await this.#destinationReceipts.getTokenAmountReceived(
      {
        transactionHash: delivery.destinationTransactionHash,
        tokenAddress: this.#route.destinationAsset.tokenAddress,
        recipientAddress: record.destinationPayerAddress,
      },
      signal,
    );
    if (amountReceivedAtomic === null) return { status: 'PENDING' };
    assertAtomic(amountReceivedAtomic, 'amountReceivedAtomic', true);
    if (BigInt(amountReceivedAtomic) < BigInt(record.minimumAmountOutAtomic)) {
      return {
        status: 'FAILED',
        destinationTransactionHash: delivery.destinationTransactionHash,
        amountReceivedAtomic,
        failureReason: `Destination ${this.#route.destinationAsset.symbol} receipt is below the authorized x402 payment ceiling`,
      };
    }
    return {
      status: 'DESTINATION_FUNDED',
      destinationTransactionHash: delivery.destinationTransactionHash,
      amountReceivedAtomic,
    };
  }

  #sendParameters(intent: CrossChainProcurementIntent, amountInAtomic: string): StargateSendParameters {
    return {
      destinationEndpointId: this.#route.destinationEndpointId,
      destinationRecipient: intent.target.payerAddress,
      amountInAtomic,
      minimumAmountOutAtomic: this.#destinationToSourceAtomicCeil(intent.target.maximumAtomicAmount),
    };
  }

  #sourceToDestinationAtomic(sourceAtomic: string): string {
    const sourceRate = decimalConversionRate(this.#route.sourceAsset.decimals, this.#route.sharedDecimals);
    const destinationRate = decimalConversionRate(this.#route.destinationAsset.decimals, this.#route.sharedDecimals);
    return ((BigInt(sourceAtomic) / sourceRate) * destinationRate).toString();
  }

  #destinationToSourceAtomicCeil(destinationAtomic: string): string {
    const sourceRate = decimalConversionRate(this.#route.sourceAsset.decimals, this.#route.sharedDecimals);
    const destinationRate = decimalConversionRate(this.#route.destinationAsset.decimals, this.#route.sharedDecimals);
    const destination = BigInt(destinationAtomic);
    const sharedUnits = (destination + destinationRate - 1n) / destinationRate;
    return (sharedUnits * sourceRate).toString();
  }

  #assertIntentRoute(intent: CrossChainProcurementIntent): void {
    if (!sameAsset(intent.funding.asset, this.#route.sourceAsset)) {
      throw new Error('Procurement funding asset is not the reviewed GOAT USDT Stargate route');
    }
    if (!sameAsset(intent.target.asset, this.#route.destinationAsset)) {
      throw new Error('Procurement target asset is not canonical BNB Chain USDT');
    }
    assertAddress(intent.target.payerAddress, 'target.payerAddress');
  }

  #assertQuoteRoute(intent: CrossChainProcurementIntent, quote: BridgeQuote): void {
    if (quote.provider !== STARGATE_V2_PROVIDER) throw new Error('Bridge quote provider is not Stargate V2');
    const expected: Readonly<Record<string, string>> = {
      routeId: this.#route.id,
      sourceOftAddress: this.#route.sourceOftAddress,
      destinationOftAddress: this.#route.destinationOftAddress,
      destinationEndpointId: String(this.#route.destinationEndpointId),
      destinationPayerAddress: intent.target.payerAddress,
    };
    for (const [key, value] of Object.entries(expected)) {
      if (quote.providerData[key]?.toLowerCase() !== value.toLowerCase()) {
        throw new Error(`Bridge quote providerData.${key} does not match the reviewed route`);
      }
    }
    assertAtomic(requiredProviderData(quote, 'nativeFeeWei'), 'quote.providerData.nativeFeeWei', true);
    assertAtomic(
      requiredProviderData(quote, 'quotedAmountOutAtomic'),
      'quote.providerData.quotedAmountOutAtomic',
      false,
    );
  }
}

const FAILURE_STATUSES = new Set(['FAILED', 'BLOCKED', 'PAYLOAD_STORED', 'APPLICATION_BURNED']);

function sameAsset(
  left: CrossChainProcurementIntent['funding']['asset'],
  right: CrossChainProcurementIntent['funding']['asset'],
): boolean {
  return (
    left.network === right.network &&
    left.tokenAddress.toLowerCase() === right.tokenAddress.toLowerCase() &&
    left.decimals === right.decimals
  );
}

function requiredProviderData(quote: BridgeQuote, key: string): string {
  const value = quote.providerData[key];
  if (!value) throw new Error(`Bridge quote providerData.${key} is required`);
  return value;
}

function positiveBigInt(value: string, field: string): bigint {
  assertAtomic(value, field, false);
  return BigInt(value);
}

function decimalConversionRate(localDecimals: number, sharedDecimals: number): bigint {
  if (!Number.isInteger(sharedDecimals) || sharedDecimals < 0 || localDecimals < sharedDecimals) {
    throw new Error('Stargate route decimals are invalid');
  }
  return 10n ** BigInt(localDecimals - sharedDecimals);
}

function assertAtomic(value: string, field: string, allowZero: boolean): void {
  if (!/^(0|[1-9]\d*)$/.test(value) || (!allowZero && BigInt(value) === 0n)) {
    throw new Error(`${field} must be ${allowZero ? 'an unsigned' : 'a positive'} atomic amount`);
  }
}

function assertAddress(value: string, field: string): asserts value is EvmAddress {
  if (!/^0x[a-fA-F0-9]{40}$/.test(value)) throw new Error(`${field} must be an EVM address`);
}

function assertHash(value: string, field: string): asserts value is TransactionHash {
  if (!/^0x[a-fA-F0-9]{64}$/.test(value)) throw new Error(`${field} must be a 32-byte transaction hash`);
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) throw new Error(`${field} cannot be empty`);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error('Operation aborted');
}
