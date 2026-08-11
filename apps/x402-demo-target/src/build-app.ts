import { BOT_CHAIN_TESTNET } from '@shipyard402/bot-chain-network-config';
import { resolveNetwork } from '@shipyard402/goat-network-config';
import type { FastifyInstance } from 'fastify';
import { createPublicClient, createWalletClient, defineChain, http, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { createDemoTargetApp } from './app.js';
import { parseDemoTargetRuntimeConfig, type DemoTargetRuntimeConfig } from './runtime-config.js';
import { createViemSettler } from './settler.js';

export type BuiltDemoTarget = Readonly<{ app: FastifyInstance; config: DemoTargetRuntimeConfig }>;

/**
 * Chain metadata for the network the target settles on. This has to follow `NETWORK`, not the GOAT
 * environment: viem signs and submits against `chain.id`, so resolving it from GOAT config while
 * pointing the transport at BOT Chain would sign for the wrong chain.
 */
function resolveChainMetadata(config: DemoTargetRuntimeConfig) {
  if (config.network === 'bot-chain-testnet') {
    return {
      id: BOT_CHAIN_TESTNET.chainId,
      name: BOT_CHAIN_TESTNET.name,
      nativeCurrency: BOT_CHAIN_TESTNET.nativeCurrency,
      explorerName: 'BOTScan',
      explorerUrl: BOT_CHAIN_TESTNET.explorerUrl,
    };
  }
  const network = resolveNetwork(config.goatEnvironment);
  return {
    id: network.chainId,
    name: network.name,
    nativeCurrency: network.nativeCurrency,
    explorerName: 'GOAT Explorer',
    explorerUrl: network.explorerUrl,
  };
}

/**
 * Builds the demo target without listening, so the same construction serves both the standalone
 * process (src/server.ts) and a serverless handler that owns the request lifecycle itself.
 */
export function buildDemoTargetApp(environment: NodeJS.ProcessEnv = process.env): BuiltDemoTarget {
  const config = parseDemoTargetRuntimeConfig(environment);
  const metadata = resolveChainMetadata(config);
  const chain = defineChain({
    id: metadata.id,
    name: metadata.name,
    nativeCurrency: metadata.nativeCurrency,
    rpcUrls: { default: { http: [config.rpcUrl] } },
    blockExplorers: { default: { name: metadata.explorerName, url: metadata.explorerUrl } },
  });
  const settlerAccount = privateKeyToAccount(config.settlerPrivateKey);
  const publicClient = createPublicClient({
    chain,
    transport: http(config.rpcUrl, { timeout: 15_000, retryCount: 2 }),
  });
  const walletClient = createWalletClient({ account: settlerAccount, chain, transport: http(config.rpcUrl) });
  const settler = createViemSettler({
    publicClient: publicClient as PublicClient,
    walletClient,
    settlerAccount,
    chain,
    tokenAddress: config.tokenAddress,
  });

  const app = createDemoTargetApp({
    mode: config.mode,
    payment: {
      chainId: config.chainId,
      asset: config.tokenAddress,
      payTo: config.receivingAddress,
      amountAtomic: config.priceAtomic,
      tokenName: config.tokenName,
      tokenVersion: config.tokenVersion,
      maxTimeoutSeconds: config.maxTimeoutSeconds,
      settler,
    },
    ...(config.providerSignerPrivateKey ? { providerSignerPrivateKey: config.providerSignerPrivateKey } : {}),
  });

  return { app, config };
}
