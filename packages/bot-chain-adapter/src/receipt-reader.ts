import type { BotChainNetwork } from '@shipyard402/bot-chain-network-config';
// ViemGoatReceiptReader has no GOAT-specific logic in it -- it's a plain viem-backed reader that
// takes an arbitrary chainId and client. Reused here as-is rather than duplicated; only this
// small factory (chain definition + public client) is BOT-Chain-specific.
import { ViemGoatReceiptReader, type GoatReadClient } from '@shipyard402/goat-chain-reader';
import { createPublicClient, defineChain, http } from 'viem';

export function createBotChainReceiptReader(network: BotChainNetwork, rpcUrl: string): ViemGoatReceiptReader {
  const parsed = new URL(rpcUrl);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error('BOT Chain RPC must be an HTTPS URL without embedded credentials');
  }
  const chain = defineChain({
    id: network.chainId,
    name: network.name,
    nativeCurrency: network.nativeCurrency,
    rpcUrls: { default: { http: [rpcUrl] } },
    blockExplorers: { default: { name: 'BOTScan', url: network.explorerUrl } },
  });
  const client = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 15_000, retryCount: 2 }) });
  return new ViemGoatReceiptReader(client as GoatReadClient, network.chainId);
}
