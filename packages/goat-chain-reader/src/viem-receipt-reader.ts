import { GOAT_MAINNET, GOAT_TESTNET3 } from '@shipyard402/goat-network-config';
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
  readonly #chainId: number;
  #chainVerification: Promise<void> | undefined;

  constructor(client: GoatReadClient, chainId: number = GOAT_MAINNET.chainId) {
    this.#client = client;
    this.#chainId = chainId;
  }

  async getTransactionReceipt(
    chainId: number,
    transactionHash: `0x${string}`,
    signal?: AbortSignal,
  ) {
    if (chainId !== this.#chainId) throw new Error(`Unsupported receipt chain: ${chainId}`);
    assertNotAborted(signal);
    // `??=` only reassigns when the field is nullish -- a *rejected* promise is neither, so
    // without the reset below one transient RPC failure on the first call would poison every
    // future call for the lifetime of this instance. Clearing it back to undefined on rejection
    // lets the next call retry verification instead of replaying a stale failure forever.
    this.#chainVerification ??= this.#verifyChain().catch((error: unknown) => {
      this.#chainVerification = undefined;
      throw error;
    });
    await this.#chainVerification;
    try {
      const receipt = await this.#client.getTransactionReceipt({ hash: transactionHash });
      assertNotAborted(signal);
      return {
        chainId: this.#chainId,
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
    if (actual !== this.#chainId) {
      throw new Error(`RPC chain mismatch: expected ${this.#chainId}, received ${actual}`);
    }
  }
}

export function createGoatMainnetReceiptReader(rpcUrl: string = GOAT_MAINNET.publicRpcUrl): ViemGoatReceiptReader {
  return createGoatReceiptReader('mainnet', rpcUrl);
}

export function createGoatTestnet3ReceiptReader(rpcUrl: string = GOAT_TESTNET3.publicRpcUrl): ViemGoatReceiptReader {
  return createGoatReceiptReader('testnet3', rpcUrl);
}

export function createGoatReceiptReader(
  environment: 'mainnet' | 'testnet3',
  rpcUrl?: string,
): ViemGoatReceiptReader {
  const network = environment === 'mainnet' ? GOAT_MAINNET : GOAT_TESTNET3;
  const selectedRpcUrl = rpcUrl ?? network.publicRpcUrl;
  const parsed = new URL(selectedRpcUrl);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error('GOAT RPC must be an HTTPS URL without embedded credentials');
  }
  const chain = defineChain({
    id: network.chainId,
    name: network.name,
    nativeCurrency: network.nativeCurrency,
    rpcUrls: { default: { http: [selectedRpcUrl] } },
    blockExplorers: { default: { name: 'GOAT Explorer', url: network.explorerUrl } },
  });
  const client = createPublicClient({ chain, transport: http(selectedRpcUrl, { timeout: 15_000, retryCount: 2 }) });
  return new ViemGoatReceiptReader(client as GoatReadClient, network.chainId);
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error('Operation aborted');
}
