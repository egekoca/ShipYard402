import { GOAT_MAINNET, GOAT_TESTNET3 } from '@shipyard402/goat-network-config';
import {
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  createPublicClient,
  defineChain,
  http,
  type PublicClient,
} from 'viem';

export type ConfirmedNativeTransfer = Readonly<{
  transactionHash: `0x${string}`;
  status: 'success' | 'reverted';
  from: `0x${string}`;
  to: `0x${string}` | null;
  valueWei: bigint;
  confirmations: bigint;
}>;

export interface NativeTransferReader {
  getConfirmedTransfer(transactionHash: `0x${string}`, signal?: AbortSignal): Promise<ConfirmedNativeTransfer | null>;
}

export class ViemNativeTransferReader implements NativeTransferReader {
  readonly #client: PublicClient;
  readonly #chainId: number;
  #chainVerification?: Promise<void>;

  constructor(client: PublicClient, chainId: number) {
    this.#client = client;
    this.#chainId = chainId;
  }

  async getConfirmedTransfer(transactionHash: `0x${string}`, signal?: AbortSignal): Promise<ConfirmedNativeTransfer | null> {
    assertNotAborted(signal);
    this.#chainVerification ??= this.#verifyChain();
    await this.#chainVerification;

    let transaction;
    let receipt;
    try {
      [transaction, receipt] = await Promise.all([
        this.#client.getTransaction({ hash: transactionHash }),
        this.#client.getTransactionReceipt({ hash: transactionHash }),
      ]);
    } catch (error) {
      if (error instanceof TransactionNotFoundError || error instanceof TransactionReceiptNotFoundError) return null;
      throw error;
    }
    assertNotAborted(signal);

    const currentBlock = await this.#client.getBlockNumber();
    const confirmations = receipt.blockNumber === null ? 0n : currentBlock - receipt.blockNumber + 1n;

    return {
      transactionHash,
      status: receipt.status === 'success' ? 'success' : 'reverted',
      from: transaction.from,
      to: transaction.to,
      valueWei: transaction.value,
      confirmations,
    };
  }

  async #verifyChain(): Promise<void> {
    const actual = await this.#client.getChainId();
    if (actual !== this.#chainId) {
      throw new Error(`RPC chain mismatch: expected ${this.#chainId}, received ${actual}`);
    }
  }
}

export function createGoatNativeTransferReader(
  environment: 'mainnet' | 'testnet3',
  rpcUrl: string,
): ViemNativeTransferReader {
  const network = environment === 'mainnet' ? GOAT_MAINNET : GOAT_TESTNET3;
  const parsed = new URL(rpcUrl);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error('GOAT RPC must be an HTTPS URL without embedded credentials');
  }
  const chain = defineChain({
    id: network.chainId,
    name: network.name,
    nativeCurrency: network.nativeCurrency,
    rpcUrls: { default: { http: [rpcUrl] } },
    blockExplorers: { default: { name: 'GOAT Explorer', url: network.explorerUrl } },
  });
  const client = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 15_000, retryCount: 2 }) });
  return new ViemNativeTransferReader(client as PublicClient, network.chainId);
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error('Operation aborted');
}
