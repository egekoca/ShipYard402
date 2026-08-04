import { flowRuntimeCapabilitySchema, GOAT_MAINNET, type FlowRuntimeCapability } from '@shipyard402/goat-network-config';
import type {
  CreateMerchantOrder,
  GoatFlowOrderStatus,
  MerchantOrder,
  MerchantPaymentProof,
  X402PaymentRequiredChallenge,
  X402MerchantAdapter,
} from '@shipyard402/x402-payments';
import {
  GoatFlowClient,
  type CreateOrderParams,
  type MerchantInfo,
  type Order,
  type OrderProof,
  type OrderProofResponse,
} from 'goatflow-sdk-server';
import { z } from 'zod';

const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const hashSchema = z.string().regex(/^0x[a-fA-F0-9]{64}$/);
const orderStatusSchema = z.enum([
  'CHECKOUT_VERIFIED',
  'PAYMENT_CONFIRMED',
  'INVOICED',
  'FAILED',
  'EXPIRED',
  'CANCELLED',
]);

export interface GoatFlowClientPort {
  createOrder(params: CreateOrderParams): Promise<Order>;
  getOrderStatus(orderId: string, opts?: { timeoutMs?: number }): Promise<OrderProof>;
  getOrderProof(orderId: string): Promise<OrderProofResponse>;
  getMerchant(merchantId: string): Promise<MerchantInfo>;
}

export type FlowOrderContext = Readonly<{
  order: MerchantOrder;
  capability: FlowRuntimeCapability;
}>;

export interface FlowOrderContextStore {
  put(context: FlowOrderContext): Promise<void>;
  get(orderId: string): Promise<FlowOrderContext | null>;
  getByDappOrderId(dappOrderId: string): Promise<FlowOrderContext | null>;
}

export interface ReviewedCapabilitySource {
  loadReviewedCapabilities(): Promise<readonly FlowRuntimeCapability[]>;
}

export type GoatFlowAdapterOptions = Readonly<{
  merchantId: string;
  client: GoatFlowClientPort;
  contextStore: FlowOrderContextStore;
  capabilitySource: ReviewedCapabilitySource;
}>;

export type GoatFlowCredentialOptions = Readonly<{
  merchantId: string;
  apiKey: string;
  apiSecret: string;
  contextStore: FlowOrderContextStore;
  capabilitySource: ReviewedCapabilitySource;
}>;

export class GoatFlowMerchantAdapter implements X402MerchantAdapter {
  readonly #merchantId: string;
  readonly #client: GoatFlowClientPort;
  readonly #contextStore: FlowOrderContextStore;
  readonly #capabilitySource: ReviewedCapabilitySource;

  constructor(options: GoatFlowAdapterOptions) {
    if (!options.merchantId) throw new Error('GOAT Flow merchant ID is required');
    this.#merchantId = options.merchantId;
    this.#client = options.client;
    this.#contextStore = options.contextStore;
    this.#capabilitySource = options.capabilitySource;
  }

  static fromMainnetCredentials(options: GoatFlowCredentialOptions): GoatFlowMerchantAdapter {
    if (!options.apiKey || !options.apiSecret) throw new Error('GOAT Flow credentials are required');
    return new GoatFlowMerchantAdapter({
      merchantId: options.merchantId,
      client: new GoatFlowClient({
        baseUrl: GOAT_MAINNET.flowApiUrl,
        apiKey: options.apiKey,
        apiSecret: options.apiSecret,
      }),
      contextStore: options.contextStore,
      capabilitySource: options.capabilitySource,
    });
  }

  async discoverRuntimeCapabilities(): Promise<readonly FlowRuntimeCapability[]> {
    const [merchant, reviewed] = await Promise.all([
      this.#client.getMerchant(this.#merchantId),
      this.#capabilitySource.loadReviewedCapabilities(),
    ]);
    if (merchant.merchantId !== this.#merchantId || merchant.receiveType !== 'DIRECT') return [];

    return reviewed
      .map((candidate) => flowRuntimeCapabilitySchema.parse(candidate))
      .filter((candidate) =>
        candidate.environment === 'mainnet' &&
        candidate.merchantId === this.#merchantId &&
        candidate.mode === 'ERC20_DIRECT' &&
        merchant.supportedTokens.some((token) =>
          token.chainId === candidate.chainId &&
          sameAddress(token.tokenContract, candidate.tokenAddress) &&
          token.symbol === candidate.tokenSymbol,
        ),
      );
  }

  async createOrder(input: CreateMerchantOrder, signal?: AbortSignal): Promise<MerchantOrder> {
    assertNotAborted(signal);
    const existing = await this.#contextStore.getByDappOrderId(input.dappOrderId);
    if (existing) {
      assertExistingContextMatches(existing, input);
      return existing.order;
    }
    const capability = flowRuntimeCapabilitySchema.parse(input.capability);
    if (capability.environment !== 'mainnet' || capability.merchantId !== this.#merchantId) {
      throw new Error('Order capability does not belong to the configured mainnet merchant');
    }
    if (BigInt(input.atomicAmount) < BigInt(capability.minimumAtomicAmount) || BigInt(input.atomicAmount) > BigInt(capability.maximumAtomicAmount)) {
      throw new Error('Order amount is outside the reviewed merchant capability bounds');
    }

    const remote = await this.#client.createOrder({
      dappOrderId: input.dappOrderId,
      chainId: capability.chainId,
      tokenSymbol: capability.tokenSymbol,
      tokenContract: capability.tokenAddress,
      fromAddress: input.payerAddress,
      amountWei: input.atomicAmount,
    });
    assertNotAborted(signal);
    assertCreatedOrderMatches(remote, input, capability);

    const order: MerchantOrder = {
      orderId: remote.orderId,
      dappOrderId: input.dappOrderId,
      status: 'CHECKOUT_VERIFIED',
      chainId: remote.fromChainId,
      tokenAddress: parseAddress(remote.tokenContract, 'order token'),
      atomicAmount: remote.amountWei,
      payerAddress: input.payerAddress,
      payToAddress: parseAddress(remote.payToAddress, 'order recipient'),
      expiresAt: new Date(remote.expiresAt * 1_000).toISOString(),
      paymentRequired: normalizeAndVerifyChallenge(remote, capability, input.atomicAmount),
    };
    await this.#contextStore.put({ order, capability });
    return order;
  }

  async getOrderStatus(orderId: string, signal?: AbortSignal): Promise<MerchantOrder> {
    assertNotAborted(signal);
    const context = await this.requireContext(orderId);
    const status = await this.#client.getOrderStatus(orderId);
    assertNotAborted(signal);
    assertStatusMatchesContext(status, context);
    return { ...context.order, status: parseOrderStatus(status.status) };
  }

  async getOrderProof(orderId: string, signal?: AbortSignal): Promise<MerchantPaymentProof> {
    assertNotAborted(signal);
    const context = await this.requireContext(orderId);
    const response = await this.#client.getOrderProof(orderId);
    assertNotAborted(signal);
    const payload = response.payload;
    if (payload.order_id !== orderId) throw new Error('GOAT Flow proof order ID mismatch');
    if (!['PAYMENT_CONFIRMED', 'INVOICED'].includes(payload.status)) {
      throw new Error(`GOAT Flow proof is not terminal-success: ${payload.status}`);
    }
    if (
      payload.from_chain_id !== context.order.chainId ||
      !sameAddress(payload.from_addr, context.order.payerAddress) ||
      !sameAddress(payload.to_addr, context.order.payToAddress) ||
      payload.amount_wei !== context.order.atomicAmount
    ) {
      throw new Error('GOAT Flow proof does not match stored order context');
    }

    return {
      orderId,
      transactionHash: parseHash(payload.tx_hash, 'transaction hash'),
      logIndex: parseNonNegativeInteger(payload.log_index, 'log index'),
      fromAddress: parseAddress(payload.from_addr, 'proof payer'),
      toAddress: parseAddress(payload.to_addr, 'proof recipient'),
      atomicAmount: payload.amount_wei,
      chainId: payload.from_chain_id,
      ...(hashSchema.safeParse(response.signature).success
        ? { providerDigest: response.signature as `0x${string}` }
        : {}),
    };
  }

  async requireContext(orderId: string): Promise<FlowOrderContext> {
    const context = await this.#contextStore.get(orderId);
    if (!context) throw new Error(`No stored order context for ${orderId}`);
    return context;
  }
}

export class InMemoryFlowOrderContextStore implements FlowOrderContextStore {
  readonly #records = new Map<string, FlowOrderContext>();
  readonly #orderIdsByDappOrderId = new Map<string, string>();

  async put(context: FlowOrderContext): Promise<void> {
    const current = this.#records.get(context.order.orderId);
    if (current && current.order.dappOrderId !== context.order.dappOrderId) {
      throw new Error('GOAT Flow order ID is already bound to another DApp order');
    }
    this.#records.set(context.order.orderId, context);
    const currentOrderId = this.#orderIdsByDappOrderId.get(context.order.dappOrderId);
    if (currentOrderId && currentOrderId !== context.order.orderId) {
      throw new Error('DApp order ID is already bound to another GOAT Flow order');
    }
    this.#orderIdsByDappOrderId.set(context.order.dappOrderId, context.order.orderId);
  }

  async get(orderId: string): Promise<FlowOrderContext | null> {
    return this.#records.get(orderId) ?? null;
  }

  async getByDappOrderId(dappOrderId: string): Promise<FlowOrderContext | null> {
    const orderId = this.#orderIdsByDappOrderId.get(dappOrderId);
    return orderId ? this.#records.get(orderId) ?? null : null;
  }
}

function assertExistingContextMatches(context: FlowOrderContext, input: CreateMerchantOrder): void {
  if (
    context.order.dappOrderId !== input.dappOrderId ||
    context.order.atomicAmount !== input.atomicAmount ||
    !sameAddress(context.order.payerAddress, input.payerAddress) ||
    context.capability.chainId !== input.capability.chainId ||
    !sameAddress(context.capability.tokenAddress, input.capability.tokenAddress) ||
    !sameAddress(context.capability.receivingAddress, input.capability.receivingAddress)
  ) {
    throw new Error('DApp order idempotency conflict');
  }
}

function assertCreatedOrderMatches(remote: Order, input: CreateMerchantOrder, capability: FlowRuntimeCapability): void {
  if (remote.flow !== 'ERC20_DIRECT') throw new Error(`Unsupported GOAT Flow payment mode: ${remote.flow}`);
  if (remote.fromChainId !== capability.chainId || remote.payToChainId !== capability.chainId) {
    throw new Error('GOAT Flow order chain does not match the reviewed capability');
  }
  if (!sameAddress(remote.tokenContract, capability.tokenAddress) || remote.tokenSymbol !== capability.tokenSymbol) {
    throw new Error('GOAT Flow order token does not match the reviewed capability');
  }
  if (!sameAddress(remote.payToAddress, capability.receivingAddress)) {
    throw new Error('GOAT Flow order recipient does not match the reviewed capability');
  }
  if (remote.amountWei !== input.atomicAmount || !remote.orderId || !Number.isSafeInteger(remote.expiresAt)) {
    throw new Error('GOAT Flow order amount, ID, or expiry is invalid');
  }
}

function normalizeAndVerifyChallenge(
  remote: Order,
  capability: FlowRuntimeCapability,
  atomicAmount: string,
): X402PaymentRequiredChallenge {
  const challenge = remote.x402;
  if (!challenge || !Number.isSafeInteger(challenge.x402Version) || challenge.accepts.length === 0) {
    throw new Error('GOAT Flow did not return a valid x402 payment-required challenge');
  }
  const matchingOption = challenge.accepts.find((option) =>
    option.network === `eip155:${capability.chainId}` &&
    option.amount === atomicAmount &&
    sameAddress(option.asset, capability.tokenAddress) &&
    sameAddress(option.payTo, capability.receivingAddress),
  );
  if (!matchingOption) throw new Error('GOAT Flow x402 challenge does not match the reviewed payment capability');

  return {
    x402Version: challenge.x402Version,
    resource: {
      url: challenge.resource.url,
      ...(challenge.resource.description === undefined ? {} : { description: challenge.resource.description }),
      ...(challenge.resource.mimeType === undefined ? {} : { mimeType: challenge.resource.mimeType }),
    },
    accepts: challenge.accepts.map((option) => ({
      scheme: option.scheme,
      network: option.network,
      amount: option.amount,
      asset: option.asset,
      payTo: option.payTo,
      maxTimeoutSeconds: option.maxTimeoutSeconds,
      ...(option.extra === undefined ? {} : { extra: option.extra }),
    })),
    ...(challenge.extensions === undefined ? {} : { extensions: challenge.extensions }),
  };
}

function assertStatusMatchesContext(status: OrderProof, context: FlowOrderContext): void {
  if (
    status.orderId !== context.order.orderId ||
    status.dappOrderId !== context.order.dappOrderId ||
    status.chainId !== context.order.chainId ||
    !sameAddress(status.tokenContract, context.order.tokenAddress) ||
    !sameAddress(status.fromAddress, context.order.payerAddress) ||
    status.amountWei !== context.order.atomicAmount
  ) {
    throw new Error('GOAT Flow status does not match stored order context');
  }
}

function parseOrderStatus(value: string): GoatFlowOrderStatus {
  return orderStatusSchema.parse(value);
}

function parseAddress(value: string, field: string): `0x${string}` {
  const parsed = addressSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid ${field}`);
  return parsed.data as `0x${string}`;
}

function parseHash(value: string, field: string): `0x${string}` {
  const parsed = hashSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid ${field}`);
  return parsed.data as `0x${string}`;
}

function parseNonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${field}`);
  return value;
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error('Operation aborted');
}
