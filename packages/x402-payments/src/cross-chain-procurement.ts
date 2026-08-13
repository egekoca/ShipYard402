/**
 * Cross-chain procurement primitives.
 *
 * Customer funding and target procurement are deliberately separate rails. A customer may fund a
 * run on GOAT while the selected x402 resource requires payment on another EVM network. In the
 * BRIDGE_THEN_PAY mode below, target payment is impossible until the bridge output has been
 * observed on the destination chain; this is intentionally different from a solver or pre-funded
 * treasury flow.
 */

export type EvmNetworkId = `eip155:${number}`;
export type EvmAddress = `0x${string}`;
export type TransactionHash = `0x${string}`;

export const GOAT_MAINNET_NETWORK = 'eip155:2345' as const satisfies EvmNetworkId;
export const GOAT_TESTNET3_NETWORK = 'eip155:48816' as const satisfies EvmNetworkId;
export const BNB_CHAIN_MAINNET_NETWORK = 'eip155:56' as const satisfies EvmNetworkId;

export type EvmAsset = Readonly<{
  network: EvmNetworkId;
  tokenAddress: EvmAddress;
  symbol: string;
  decimals: number;
}>;

export type CustomerFundingRail = Readonly<{
  role: 'CUSTOMER_FUNDING';
  asset: EvmAsset;
  payerAddress: EvmAddress;
  maximumAtomicAmount: string;
}>;

export type TargetPaymentRail = Readonly<{
  role: 'TARGET_PAYMENT';
  asset: EvmAsset;
  scheme: 'exact';
  /** Destination-chain wallet that receives bridge output and signs the x402 authorization. */
  payerAddress: EvmAddress;
  /**
   * The recipient, when it is known in advance. A discovered service publishes its own `payTo` in
   * the 402 challenge, so this is absent for anything but a pinned counterparty; the payer's policy
   * is what bounds an unpinned payment.
   */
  payToAddress?: EvmAddress;
  maximumAtomicAmount: string;
}>;

export type CrossChainProcurementIntent = Readonly<{
  runId: string;
  mode: 'BRIDGE_THEN_PAY';
  funding: CustomerFundingRail;
  target: TargetPaymentRail;
  expiresAt: string;
}>;

export type BridgeQuote = Readonly<{
  quoteId: string;
  provider: string;
  sourceAsset: EvmAsset;
  destinationAsset: EvmAsset;
  amountInAtomic: string;
  minimumAmountOutAtomic: string;
  feeAtomic: string;
  expiresAt: string;
  /** Provider-specific values needed to reproduce and safely submit this exact quote. */
  providerData: Readonly<Record<string, string>>;
}>;

export interface CrossChainBridgePort {
  quote(intent: CrossChainProcurementIntent, signal?: AbortSignal): Promise<BridgeQuote>;
  submit(
    input: Readonly<{ intent: CrossChainProcurementIntent; quote: BridgeQuote; idempotencyKey: string }>,
    signal?: AbortSignal,
  ): Promise<Readonly<{ transferId: string; sourceTransactionHash: TransactionHash }>>;
  getStatus(
    transferId: string,
    signal?: AbortSignal,
  ): Promise<
    Readonly<{
      status: 'PENDING' | 'DESTINATION_FUNDED' | 'FAILED' | 'REFUNDED';
      destinationTransactionHash?: TransactionHash;
      amountReceivedAtomic?: string;
      failureReason?: string;
    }>
  >;
}

export type CrossChainProcurementState =
  | Readonly<{ status: 'AWAITING_SOURCE_LOCK' }>
  | Readonly<{ status: 'SOURCE_LOCKED'; sourceTransactionHash: TransactionHash }>
  | Readonly<{ status: 'BRIDGING'; sourceTransactionHash: TransactionHash; transferId: string }>
  | Readonly<{
      status: 'DESTINATION_FUNDED';
      sourceTransactionHash: TransactionHash;
      transferId: string;
      destinationTransactionHash: TransactionHash;
      amountReceivedAtomic: string;
    }>
  | Readonly<{
      status: 'TARGET_PAYMENT_SUBMITTED';
      sourceTransactionHash: TransactionHash;
      transferId: string;
      destinationTransactionHash: TransactionHash;
      amountReceivedAtomic: string;
      paymentId: string;
    }>
  | Readonly<{
      status: 'TARGET_PAID';
      sourceTransactionHash: TransactionHash;
      transferId: string;
      destinationTransactionHash: TransactionHash;
      amountReceivedAtomic: string;
      paymentId: string;
      targetPaymentTransactionHash: TransactionHash;
      amountSpentAtomic: string;
    }>
  | Readonly<{
      status: 'ATTESTED';
      targetPaymentTransactionHash: TransactionHash;
      attestationTransactionHash: TransactionHash;
    }>
  | Readonly<{ status: 'REFUND_PENDING'; reason: string }>
  | Readonly<{ status: 'REFUNDED'; reason: string; refundTransactionHash: TransactionHash }>
  | Readonly<{ status: 'FAILED'; reason: string }>;

export type CrossChainProcurementEvent =
  | Readonly<{ type: 'SOURCE_FUNDS_LOCKED'; sourceTransactionHash: TransactionHash }>
  | Readonly<{ type: 'BRIDGE_SUBMITTED'; transferId: string }>
  | Readonly<{
      type: 'DESTINATION_FUNDS_RECEIVED';
      destinationTransactionHash: TransactionHash;
      amountReceivedAtomic: string;
    }>
  | Readonly<{ type: 'TARGET_PAYMENT_CREATED'; paymentId: string }>
  | Readonly<{
      type: 'TARGET_PAYMENT_CONFIRMED';
      targetPaymentTransactionHash: TransactionHash;
      amountSpentAtomic: string;
    }>
  | Readonly<{ type: 'ATTESTATION_CONFIRMED'; attestationTransactionHash: TransactionHash }>
  | Readonly<{ type: 'REFUND_REQUESTED'; reason: string }>
  | Readonly<{ type: 'REFUND_CONFIRMED'; refundTransactionHash: TransactionHash }>
  | Readonly<{ type: 'FAILED'; reason: string }>;

export function createCrossChainProcurementIntent(
  input: Omit<CrossChainProcurementIntent, 'mode'>,
): CrossChainProcurementIntent {
  assertNonEmpty(input.runId, 'runId');
  assertAsset(input.funding.asset, 'funding.asset');
  assertAsset(input.target.asset, 'target.asset');
  assertAddress(input.funding.payerAddress, 'funding.payerAddress');
  assertAddress(input.target.payerAddress, 'target.payerAddress');
  if (input.target.payToAddress !== undefined) assertAddress(input.target.payToAddress, 'target.payToAddress');
  assertAtomicAmount(input.funding.maximumAtomicAmount, 'funding.maximumAtomicAmount', false);
  assertAtomicAmount(input.target.maximumAtomicAmount, 'target.maximumAtomicAmount', false);
  assertFutureDate(input.expiresAt, 'intent.expiresAt');

  if (input.funding.asset.network === input.target.asset.network) {
    throw new Error('Cross-chain procurement requires different funding and target networks');
  }

  return Object.freeze({ ...input, mode: 'BRIDGE_THEN_PAY' });
}

/**
 * Fail closed before a bridge signature is requested. The bridge output must cover the complete
 * target ceiling after fees/slippage, and the route must deliver the exact asset the x402 target
 * accepts. A wrapped substitute is not treated as equivalent to canonical destination USDC.
 */
export function assertBridgeQuotePayable(intent: CrossChainProcurementIntent, quote: BridgeQuote, now: Date): void {
  assertAsset(quote.sourceAsset, 'quote.sourceAsset');
  assertAsset(quote.destinationAsset, 'quote.destinationAsset');
  assertAtomicAmount(quote.amountInAtomic, 'quote.amountInAtomic', false);
  assertAtomicAmount(quote.minimumAmountOutAtomic, 'quote.minimumAmountOutAtomic', false);
  assertAtomicAmount(quote.feeAtomic, 'quote.feeAtomic', true);
  assertNonEmpty(quote.quoteId, 'quote.quoteId');
  assertNonEmpty(quote.provider, 'quote.provider');
  if (Object.keys(quote.providerData).length === 0) throw new Error('quote.providerData cannot be empty');

  if (!sameAsset(intent.funding.asset, quote.sourceAsset)) {
    throw new Error('Bridge quote source asset does not match the customer funding rail');
  }
  if (!sameAsset(intent.target.asset, quote.destinationAsset)) {
    throw new Error('Bridge quote destination asset does not match the target payment rail');
  }
  if (BigInt(quote.amountInAtomic) > BigInt(intent.funding.maximumAtomicAmount)) {
    throw new Error('Bridge input exceeds the customer funding ceiling');
  }
  if (BigInt(quote.minimumAmountOutAtomic) < BigInt(intent.target.maximumAtomicAmount)) {
    throw new Error('Bridge minimum output cannot cover the target payment ceiling');
  }

  const quoteExpiry = Date.parse(quote.expiresAt);
  const intentExpiry = Date.parse(intent.expiresAt);
  if (!Number.isFinite(quoteExpiry) || quoteExpiry <= now.getTime()) throw new Error('Bridge quote has expired');
  if (quoteExpiry > intentExpiry) throw new Error('Bridge quote outlives the procurement intent');
}

/**
 * Pure state transition guard. In particular, TARGET_PAYMENT_CREATED is only accepted after a
 * destination-chain funding transaction has been observed and its amount covers the target cap.
 */
export function transitionCrossChainProcurement(
  state: CrossChainProcurementState,
  event: CrossChainProcurementEvent,
  targetMaximumAtomicAmount: string,
): CrossChainProcurementState {
  assertAtomicAmount(targetMaximumAtomicAmount, 'targetMaximumAtomicAmount', false);

  if (event.type === 'FAILED') return { status: 'FAILED', reason: requireReason(event.reason) };
  if (event.type === 'REFUND_REQUESTED') {
    if (state.status === 'ATTESTED' || state.status === 'REFUNDED') {
      throw new Error(`Cannot request a refund from ${state.status}`);
    }
    return { status: 'REFUND_PENDING', reason: requireReason(event.reason) };
  }
  if (event.type === 'REFUND_CONFIRMED') {
    if (state.status !== 'REFUND_PENDING') throw invalidTransition(state, event);
    assertHash(event.refundTransactionHash, 'refundTransactionHash');
    return { status: 'REFUNDED', reason: state.reason, refundTransactionHash: event.refundTransactionHash };
  }

  switch (state.status) {
    case 'AWAITING_SOURCE_LOCK':
      if (event.type !== 'SOURCE_FUNDS_LOCKED') throw invalidTransition(state, event);
      assertHash(event.sourceTransactionHash, 'sourceTransactionHash');
      return { status: 'SOURCE_LOCKED', sourceTransactionHash: event.sourceTransactionHash };
    case 'SOURCE_LOCKED':
      if (event.type !== 'BRIDGE_SUBMITTED') throw invalidTransition(state, event);
      assertNonEmpty(event.transferId, 'transferId');
      return { status: 'BRIDGING', sourceTransactionHash: state.sourceTransactionHash, transferId: event.transferId };
    case 'BRIDGING':
      if (event.type !== 'DESTINATION_FUNDS_RECEIVED') throw invalidTransition(state, event);
      assertHash(event.destinationTransactionHash, 'destinationTransactionHash');
      assertAtomicAmount(event.amountReceivedAtomic, 'amountReceivedAtomic', false);
      if (BigInt(event.amountReceivedAtomic) < BigInt(targetMaximumAtomicAmount)) {
        throw new Error('Destination funding cannot cover the target payment ceiling');
      }
      return {
        status: 'DESTINATION_FUNDED',
        sourceTransactionHash: state.sourceTransactionHash,
        transferId: state.transferId,
        destinationTransactionHash: event.destinationTransactionHash,
        amountReceivedAtomic: event.amountReceivedAtomic,
      };
    case 'DESTINATION_FUNDED':
      if (event.type !== 'TARGET_PAYMENT_CREATED') throw invalidTransition(state, event);
      assertNonEmpty(event.paymentId, 'paymentId');
      return { ...state, status: 'TARGET_PAYMENT_SUBMITTED', paymentId: event.paymentId };
    case 'TARGET_PAYMENT_SUBMITTED':
      if (event.type !== 'TARGET_PAYMENT_CONFIRMED') throw invalidTransition(state, event);
      assertHash(event.targetPaymentTransactionHash, 'targetPaymentTransactionHash');
      assertAtomicAmount(event.amountSpentAtomic, 'amountSpentAtomic', false);
      if (BigInt(event.amountSpentAtomic) > BigInt(targetMaximumAtomicAmount)) {
        throw new Error('Target payment exceeded its authorized ceiling');
      }
      return {
        ...state,
        status: 'TARGET_PAID',
        targetPaymentTransactionHash: event.targetPaymentTransactionHash,
        amountSpentAtomic: event.amountSpentAtomic,
      };
    case 'TARGET_PAID':
      if (event.type !== 'ATTESTATION_CONFIRMED') throw invalidTransition(state, event);
      assertHash(event.attestationTransactionHash, 'attestationTransactionHash');
      return {
        status: 'ATTESTED',
        targetPaymentTransactionHash: state.targetPaymentTransactionHash,
        attestationTransactionHash: event.attestationTransactionHash,
      };
    case 'ATTESTED':
    case 'REFUND_PENDING':
    case 'REFUNDED':
    case 'FAILED':
      throw invalidTransition(state, event);
  }
}

function sameAsset(left: EvmAsset, right: EvmAsset): boolean {
  return (
    left.network === right.network &&
    left.tokenAddress.toLowerCase() === right.tokenAddress.toLowerCase() &&
    left.decimals === right.decimals
  );
}

function assertAsset(asset: EvmAsset, field: string): void {
  if (!/^eip155:[1-9]\d*$/.test(asset.network)) throw new Error(`${field}.network must be a CAIP-2 EVM id`);
  assertAddress(asset.tokenAddress, `${field}.tokenAddress`);
  assertNonEmpty(asset.symbol, `${field}.symbol`);
  if (!Number.isInteger(asset.decimals) || asset.decimals < 0 || asset.decimals > 36) {
    throw new Error(`${field}.decimals must be an integer between 0 and 36`);
  }
}

function assertAddress(value: string, field: string): asserts value is EvmAddress {
  if (!/^0x[a-fA-F0-9]{40}$/.test(value)) throw new Error(`${field} must be an EVM address`);
}

function assertHash(value: string, field: string): asserts value is TransactionHash {
  if (!/^0x[a-fA-F0-9]{64}$/.test(value)) throw new Error(`${field} must be a 32-byte transaction hash`);
}

function assertAtomicAmount(value: string, field: string, allowZero: boolean): void {
  if (!/^(0|[1-9]\d*)$/.test(value) || (!allowZero && BigInt(value) === 0n)) {
    throw new Error(`${field} must be ${allowZero ? 'an unsigned' : 'a positive'} atomic amount`);
  }
}

function assertFutureDate(value: string, field: string): void {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${field} must be an ISO date`);
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) throw new Error(`${field} cannot be empty`);
}

function requireReason(reason: string): string {
  assertNonEmpty(reason, 'reason');
  return reason;
}

function invalidTransition(state: CrossChainProcurementState, event: CrossChainProcurementEvent): Error {
  return new Error(`Cannot apply ${event.type} while cross-chain procurement is ${state.status}`);
}
