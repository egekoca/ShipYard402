import type { BotChainRuntimeCapability } from '@shipyard402/bot-chain-network-config';
import type { FlowRuntimeCapability } from '@shipyard402/goat-network-config';

export type GoatFlowOrderStatus =
  | 'CHECKOUT_VERIFIED'
  | 'PAYMENT_CONFIRMED'
  | 'INVOICED'
  | 'FAILED'
  | 'EXPIRED'
  | 'CANCELLED';

// A merchant capability describes one reviewed way to accept payment for a run: which chain,
// which token, which receiving address. GOAT Flow capabilities are discovered from GOAT's own
// merchant API; BOT Chain has no such API, so its capability is declared directly from static
// config (see @shipyard402/bot-chain-network-config) and verified purely on-chain instead.
export type MerchantCapability = FlowRuntimeCapability | BotChainRuntimeCapability;

export type CreateMerchantOrder = Readonly<{
  dappOrderId: string;
  payerAddress: `0x${string}`;
  atomicAmount: string;
  capability: MerchantCapability;
}>;

export type X402PaymentRequiredChallenge = Readonly<{
  x402Version: number;
  resource: Readonly<{
    url: string;
    description?: string;
    mimeType?: string;
  }>;
  accepts: readonly Readonly<{
    scheme: string;
    network: string;
    amount: string;
    asset: string;
    payTo: string;
    maxTimeoutSeconds: number;
    extra?: Readonly<Record<string, unknown>>;
  }>[];
  extensions?: Readonly<Record<string, unknown>>;
}>;

export type MerchantOrder = Readonly<{
  orderId: string;
  dappOrderId: string;
  status: GoatFlowOrderStatus;
  chainId: number;
  tokenAddress: `0x${string}`;
  atomicAmount: string;
  payerAddress: `0x${string}`;
  payToAddress: `0x${string}`;
  expiresAt: string;
  paymentRequired: X402PaymentRequiredChallenge;
}>;

export type MerchantPaymentProof = Readonly<{
  orderId: string;
  transactionHash: `0x${string}`;
  logIndex: number;
  fromAddress: `0x${string}`;
  toAddress: `0x${string}`;
  atomicAmount: string;
  chainId: number;
  providerDigest?: `0x${string}`;
}>;

export interface X402MerchantAdapter {
  discoverRuntimeCapabilities(): Promise<readonly MerchantCapability[]>;
  createOrder(input: CreateMerchantOrder, signal?: AbortSignal): Promise<MerchantOrder>;
  getOrderStatus(orderId: string, signal?: AbortSignal): Promise<MerchantOrder>;
  getOrderProof(orderId: string, signal?: AbortSignal): Promise<MerchantPaymentProof>;
}

export type PurchaseToolRequest = Readonly<{
  runId: string;
  providerServiceId: string;
  endpoint: URL;
  maximumAtomicAmount: string;
  idempotencyKey: string;
}>;

export type PaidToolDelivery = Readonly<{
  order: MerchantOrder;
  proof: MerchantPaymentProof;
  responseStatus: number;
  responseContentType: string;
  responseBodyHash: `0x${string}`;
}>;

export interface X402PayerAdapter {
  purchaseTool(input: PurchaseToolRequest, signal?: AbortSignal): Promise<PaidToolDelivery>;
}
