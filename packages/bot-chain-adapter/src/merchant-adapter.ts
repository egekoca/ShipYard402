import type { BotChainRuntimeCapability } from '@shipyard402/bot-chain-network-config';
import type {
  CreateMerchantOrder,
  GoatFlowOrderStatus,
  MerchantOrder,
  MerchantPaymentProof,
  X402MerchantAdapter,
} from '@shipyard402/x402-payments';
import type { NormalizedTransactionReceipt } from '@shipyard402/x402-payments';
import { Interface, getAddress, id, randomBytes, hexlify } from 'ethers';

const transferInterface = new Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);
const TRANSFER_TOPIC = id('Transfer(address,address,uint256)');

export interface BotChainReceiptSource {
  getTransactionReceipt(
    chainId: number,
    transactionHash: `0x${string}`,
    signal?: AbortSignal,
  ): Promise<NormalizedTransactionReceipt | null>;
}

export type BotChainOrderContext = Readonly<{
  order: MerchantOrder;
  capability: BotChainRuntimeCapability;
  submittedTransactionHash?: `0x${string}`;
  proof?: MerchantPaymentProof;
}>;

export interface BotChainOrderContextStore {
  put(context: BotChainOrderContext): Promise<void>;
  get(orderId: string): Promise<BotChainOrderContext | null>;
  getByDappOrderId(dappOrderId: string): Promise<BotChainOrderContext | null>;
}

export type BotChainAdapterOptions = Readonly<{
  capability: BotChainRuntimeCapability;
  contextStore: BotChainOrderContextStore;
  receiptSource: BotChainReceiptSource;
  /** How long a customer has to pay before an order expires. Defaults to 30 minutes. */
  orderTtlSeconds?: number;
  now?: () => Date;
}>;

/**
 * BOT Chain has no merchant/order/checkout API like GOAT Flow -- there is nothing to call to
 * create an order or ask "has this been paid yet". This adapter fills that gap by self-issuing
 * orders and verifying payment purely from a transaction hash the customer's wallet already has
 * (submitted via `submitPaymentTransaction`, mirroring how procurement payments are already
 * verified chain-directly elsewhere in this codebase -- see
 * apps/x402-demo-target/src/settler.ts). The synthesized order/proof pair is
 * structurally identical to what GoatFlowMerchantAdapter produces, so
 * `packages/x402-payments`'s `verifySettlement` and `packages/payment-reconciliation`'s
 * reconciliation loop work against it completely unchanged.
 */
export class BotChainDirectMerchantAdapter implements X402MerchantAdapter {
  readonly #capability: BotChainRuntimeCapability;
  readonly #contextStore: BotChainOrderContextStore;
  readonly #receiptSource: BotChainReceiptSource;
  readonly #orderTtlSeconds: number;
  readonly #now: () => Date;

  constructor(options: BotChainAdapterOptions) {
    this.#capability = options.capability;
    this.#contextStore = options.contextStore;
    this.#receiptSource = options.receiptSource;
    this.#orderTtlSeconds = options.orderTtlSeconds ?? 1_800;
    this.#now = options.now ?? (() => new Date());
  }

  async discoverRuntimeCapabilities(): Promise<readonly BotChainRuntimeCapability[]> {
    return [this.#capability];
  }

  async createOrder(input: CreateMerchantOrder, signal?: AbortSignal): Promise<MerchantOrder> {
    assertNotAborted(signal);
    const existing = await this.#contextStore.getByDappOrderId(input.dappOrderId);
    if (existing) {
      assertExistingContextMatches(existing, input);
      return existing.order;
    }
    const capability = input.capability;
    if (capability.mode !== 'DIRECT_ERC20' || capability.chainId !== this.#capability.chainId) {
      throw new Error('Order capability does not belong to the configured BOT Chain merchant');
    }
    if (
      BigInt(input.atomicAmount) < BigInt(capability.minimumAtomicAmount) ||
      BigInt(input.atomicAmount) > BigInt(capability.maximumAtomicAmount)
    ) {
      throw new Error('Order amount is outside the reviewed merchant capability bounds');
    }

    const now = this.#now();
    const order: MerchantOrder = {
      orderId: `bot_${hexlify(randomBytes(16)).slice(2)}`,
      dappOrderId: input.dappOrderId,
      status: 'CHECKOUT_VERIFIED',
      chainId: capability.chainId,
      tokenAddress: parseAddress(capability.tokenAddress, 'capability token'),
      atomicAmount: input.atomicAmount,
      payerAddress: input.payerAddress,
      payToAddress: parseAddress(capability.receivingAddress, 'capability receiving address'),
      expiresAt: new Date(now.getTime() + this.#orderTtlSeconds * 1_000).toISOString(),
      paymentRequired: {
        x402Version: 1,
        resource: { url: `botchain:order:${input.dappOrderId}` },
        accepts: [
          {
            scheme: 'exact',
            network: `eip155:${capability.chainId}`,
            amount: input.atomicAmount,
            asset: capability.tokenAddress,
            payTo: capability.receivingAddress,
            maxTimeoutSeconds: this.#orderTtlSeconds,
          },
        ],
      },
    };
    await this.#contextStore.put({ order, capability });
    return order;
  }

  /**
   * Not part of the `X402MerchantAdapter` port -- called once the customer's wallet has sent the
   * payment and has the resulting transaction hash in hand (apps/web-dashboard's
   * `wallet-pay-panel.tsx` already receives this from `sendErc20Payment`, it just isn't sent
   * anywhere today because GOAT Flow discovers it independently). `getOrderStatus`/`getOrderProof`
   * only report a payment once this has been called and the hash verifies on-chain.
   */
  async submitPaymentTransaction(orderId: string, transactionHash: `0x${string}`): Promise<void> {
    const context = await this.requireContext(orderId);
    if (context.proof && context.submittedTransactionHash !== transactionHash) {
      throw new Error('Payment is already confirmed with a different transaction hash');
    }
    // A wallet RPC can return a hash that never reaches the canonical BOT RPC (for example after
    // a dropped/replaced transaction or through a stale custom RPC). Until an exact Transfer has
    // produced a proof, accepting a replacement hash remains safe.
    await this.#contextStore.put({ ...context, submittedTransactionHash: transactionHash });
  }

  async getOrderStatus(orderId: string, signal?: AbortSignal): Promise<MerchantOrder> {
    assertNotAborted(signal);
    const context = await this.requireContext(orderId);
    if (context.proof) return { ...context.order, status: 'PAYMENT_CONFIRMED' };
    if (!context.submittedTransactionHash) {
      return { ...context.order, status: this.#isExpired(context.order) ? 'EXPIRED' : 'CHECKOUT_VERIFIED' };
    }

    const proof = await this.#tryVerifyPayment(context, signal);
    if (!proof) {
      return { ...context.order, status: this.#isExpired(context.order) ? 'EXPIRED' : 'CHECKOUT_VERIFIED' };
    }
    const confirmedOrder: MerchantOrder = { ...context.order, status: 'PAYMENT_CONFIRMED' };
    await this.#contextStore.put({ ...context, order: confirmedOrder, proof });
    return confirmedOrder;
  }

  async getOrderProof(orderId: string, signal?: AbortSignal): Promise<MerchantPaymentProof> {
    assertNotAborted(signal);
    const context = await this.requireContext(orderId);
    if (context.proof) return context.proof;
    const proof = await this.#tryVerifyPayment(context, signal);
    if (!proof) throw new Error(`No verified payment yet for order ${orderId}`);
    const confirmedOrder: MerchantOrder = { ...context.order, status: 'PAYMENT_CONFIRMED' };
    await this.#contextStore.put({ ...context, order: confirmedOrder, proof });
    return proof;
  }

  async requireContext(orderId: string): Promise<BotChainOrderContext> {
    const context = await this.#contextStore.get(orderId);
    if (!context) throw new Error(`No stored order context for ${orderId}`);
    return context;
  }

  #isExpired(order: MerchantOrder): boolean {
    return this.#now().getTime() > new Date(order.expiresAt).getTime();
  }

  async #tryVerifyPayment(context: BotChainOrderContext, signal?: AbortSignal): Promise<MerchantPaymentProof | null> {
    const transactionHash = context.submittedTransactionHash;
    if (!transactionHash) return null;
    const receipt = await this.#receiptSource.getTransactionReceipt(context.order.chainId, transactionHash, signal);
    if (receipt?.status !== 1) return null;

    const match = findMatchingTransferLog(receipt, {
      tokenAddress: context.order.tokenAddress,
      fromAddress: context.order.payerAddress,
      toAddress: context.order.payToAddress,
      atomicAmount: context.order.atomicAmount,
    });
    if (!match) return null;

    return {
      orderId: context.order.orderId,
      transactionHash,
      logIndex: match.logIndex,
      fromAddress: context.order.payerAddress,
      toAddress: context.order.payToAddress,
      atomicAmount: context.order.atomicAmount,
      chainId: context.order.chainId,
    };
  }
}

export class InMemoryBotChainOrderContextStore implements BotChainOrderContextStore {
  readonly #records = new Map<string, BotChainOrderContext>();
  readonly #orderIdsByDappOrderId = new Map<string, string>();

  async put(context: BotChainOrderContext): Promise<void> {
    const current = this.#records.get(context.order.orderId);
    if (current && current.order.dappOrderId !== context.order.dappOrderId) {
      throw new Error('BOT Chain order ID is already bound to another DApp order');
    }
    const currentOrderId = this.#orderIdsByDappOrderId.get(context.order.dappOrderId);
    if (currentOrderId && currentOrderId !== context.order.orderId) {
      throw new Error('DApp order ID is already bound to another BOT Chain order');
    }
    this.#records.set(context.order.orderId, context);
    this.#orderIdsByDappOrderId.set(context.order.dappOrderId, context.order.orderId);
  }

  async get(orderId: string): Promise<BotChainOrderContext | null> {
    return this.#records.get(orderId) ?? null;
  }

  async getByDappOrderId(dappOrderId: string): Promise<BotChainOrderContext | null> {
    const orderId = this.#orderIdsByDappOrderId.get(dappOrderId);
    return orderId ? (this.#records.get(orderId) ?? null) : null;
  }
}

function assertExistingContextMatches(context: BotChainOrderContext, input: CreateMerchantOrder): void {
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

function findMatchingTransferLog(
  receipt: NormalizedTransactionReceipt,
  expected: Readonly<{
    tokenAddress: `0x${string}`;
    fromAddress: `0x${string}`;
    toAddress: `0x${string}`;
    atomicAmount: string;
  }>,
): { logIndex: number } | null {
  for (const log of receipt.logs) {
    if (!sameAddress(log.address, expected.tokenAddress) || log.topics[0] !== TRANSFER_TOPIC) continue;
    try {
      const parsed = transferInterface.parseLog({ topics: [...log.topics], data: log.data });
      if (!parsed) continue;
      if (
        sameAddress(String(parsed.args['from']), expected.fromAddress) &&
        sameAddress(String(parsed.args['to']), expected.toAddress) &&
        BigInt(parsed.args['value']) === BigInt(expected.atomicAmount)
      ) {
        return { logIndex: log.index };
      }
    } catch {}
  }
  return null;
}

function parseAddress(value: string, field: string): `0x${string}` {
  try {
    return getAddress(value) as `0x${string}`;
  } catch {
    throw new Error(`Invalid ${field}`);
  }
}

function sameAddress(left: string, right: string): boolean {
  try {
    return getAddress(left) === getAddress(right);
  } catch {
    return false;
  }
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error('Operation aborted');
}

// Re-exported so callers that only import from this module still have the status vocabulary
// without reaching into @shipyard402/x402-payments directly.
export type { GoatFlowOrderStatus as BotChainOrderStatus };
