import { GOAT_MAINNET } from '@shipyard402/goat-network-config';
import type { ChainReceiptReader } from '@shipyard402/payment-reconciliation';
import {
  TransactionReceiptNotFoundError,
  createPublicClient,
  defineChain,
  http,
} from 'viem';

type ReceiptLike = Readonly<{
  transactionHash: `0x${string}`;
  status: 'success' | 'reverted';
  logs: readonly Readonly<{
    address: `0x${string}`;
    topics: readonly `0x${string}`[];
    data: `0x${string}`;
    logIndex: number;
  }>[];
}>;

export interface GoatReadClient {
  getChainId(): Promise<number>;
  getTransactionReceipt(input: Readonly<{ hash: `0x${string}` }>): Promise<ReceiptLike>;
}

export class ViemGoatReceiptReader implements ChainReceiptReader {
  readonly #client: GoatReadClient;
  #chainVerification?: Promise<void>;

  constructor(client: GoatReadClient) {
    this.#client = client;
  }

  async getTransactionReceipt(
    chainId: number,
    transactionHash: `0x${string}`,
    signal?: AbortSignal,
  ) {
    if (chainId !== GOAT_MAINNET.chainId) throw new Error(`Unsupported receipt chain: ${chainId}`);
    assertNotAborted(signal);
    this.#chainVerification ??= this.#verifyChain();
    await this.#chainVerification;
    try {
      const receipt = await this.#client.getTransactionReceipt({ hash: transactionHash });
      assertNotAborted(signal);
      return {
        chainId: GOAT_MAINNET.chainId,
        transactionHash: receipt.transactionHash,
        status: receipt.status === 'success' ? 1 as const : 0 as const,
        logs: receipt.logs.map((log) => ({
          address: log.address,
          topics: log.topics,
          data: log.data,
          index: log.logIndex,
        })),
      };
    } catch (error) {
      if (error instanceof TransactionReceiptNotFoundError) return null;
      throw error;
    }
  }

  async #verifyChain(): Promise<void> {
    const actual = await this.#client.getChainId();
    if (actual !== GOAT_MAINNET.chainId) {
      throw new Error(`RPC chain mismatch: expected ${GOAT_MAINNET.chainId}, received ${actual}`);
    }
  }
}

export function createGoatMainnetReceiptReader(rpcUrl = GOAT_MAINNET.publicRpcUrl): ViemGoatReceiptReader {
  const parsed = new URL(rpcUrl);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error('GOAT mainnet RPC must be an HTTPS URL without embedded credentials');
  }
  const chain = defineChain({
    id: GOAT_MAINNET.chainId,
    name: GOAT_MAINNET.name,
    nativeCurrency: GOAT_MAINNET.nativeCurrency,
    rpcUrls: { default: { http: [rpcUrl] } },
    blockExplorers: { default: { name: 'GOAT Explorer', url: GOAT_MAINNET.explorerUrl } },
  });
  const client = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 15_000, retryCount: 2 }) });
  return new ViemGoatReceiptReader(client as GoatReadClient);
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error('Operation aborted');
}
