import { assertExactUrl } from '@shipyard402/goat-network-config';
import { z } from 'zod';

export const BOT_CHAIN_MAINNET = Object.freeze({
  chainId: 677,
  chainIdHex: '0x2a5',
  name: 'BOT Chain',
  nativeCurrency: Object.freeze({ name: 'BOT', symbol: 'BOT', decimals: 18 }),
  publicRpcUrl: 'https://rpc.botchain.ai',
  explorerUrl: 'https://scan.botchain.ai',
});

export const BOT_CHAIN_TESTNET = Object.freeze({
  chainId: 968,
  chainIdHex: '0x3c8',
  name: 'BOT Chain Testnet',
  nativeCurrency: Object.freeze({ name: 'BOT', symbol: 'BOT', decimals: 18 }),
  publicRpcUrl: 'https://rpc.bohr.life',
  explorerUrl: 'https://scan.bohr.life',
});

export type BotChainEnvironment = 'botChainMainnet' | 'botChainTestnet';

export type BotChainNetwork = typeof BOT_CHAIN_MAINNET | typeof BOT_CHAIN_TESTNET;

export function resolveBotChainNetwork(environment: BotChainEnvironment): BotChainNetwork {
  return environment === 'botChainMainnet' ? BOT_CHAIN_MAINNET : BOT_CHAIN_TESTNET;
}

// BOT Chain has no equivalent of GOAT Flow's merchant/order/checkout API -- there is nothing to
// "discover" a capability from. This capability is declared directly from our own configuration
// (receiving wallet, accepted token) and verified purely against on-chain data by
// @shipyard402/bot-chain-adapter, never against a remote order-tracking service.
export const botChainRuntimeCapabilitySchema = z
  .object({
    environment: z.enum(['botChainMainnet', 'botChainTestnet']),
    merchantId: z.string().min(1),
    mode: z.literal('DIRECT_ERC20'),
    chainId: z.number().int().positive(),
    tokenAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    tokenSymbol: z.string().min(1).max(32),
    tokenDecimals: z.number().int().min(0).max(36),
    receivingAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    minimumAtomicAmount: z.string().regex(/^(0|[1-9]\d*)$/),
    maximumAtomicAmount: z.string().regex(/^(0|[1-9]\d*)$/),
    discoveredAt: z.string().datetime(),
    source: z.literal('STATIC_CONFIG'),
  })
  .strict()
  .superRefine((capability, context) => {
    if (BigInt(capability.minimumAtomicAmount) > BigInt(capability.maximumAtomicAmount)) {
      context.addIssue({
        code: 'custom',
        path: ['minimumAtomicAmount'],
        message: 'Minimum amount cannot exceed maximum amount',
      });
    }
    const expectedChain = resolveBotChainNetwork(capability.environment).chainId;
    if (capability.chainId !== expectedChain) {
      context.addIssue({
        code: 'custom',
        path: ['chainId'],
        message: `Chain does not match ${capability.environment}`,
      });
    }
  });

export type BotChainRuntimeCapability = z.infer<typeof botChainRuntimeCapabilitySchema>;

type ErrorFactory = (message: string, fields: readonly string[]) => Error;

/** Resolves the RPC URL for `environment`, applying an env override if present and validating it against the reviewed public origin. */
export function resolveBotChainRpcUrl(
  environment: BotChainEnvironment,
  overrides: Readonly<{ mainnetRpcUrl?: string | undefined; testnetRpcUrl?: string | undefined }>,
  createError: ErrorFactory,
): string {
  const network = resolveBotChainNetwork(environment);
  const field = environment === 'botChainMainnet' ? 'BOTCHAIN_MAINNET_RPC_URL' : 'BOTCHAIN_TESTNET_RPC_URL';
  const rpcUrl =
    (environment === 'botChainMainnet' ? overrides.mainnetRpcUrl : overrides.testnetRpcUrl) ?? network.publicRpcUrl;
  assertExactUrl(rpcUrl, network.publicRpcUrl, field, createError);
  return rpcUrl;
}

/** Builds and validates a `BotChainRuntimeCapability` from configured merchant fields, filling in mode/chainId/discoveredAt. */
export function parseBotChainMerchantCapability(
  input: Readonly<{
    environment: BotChainEnvironment;
    merchantId: string;
    tokenAddress: string;
    tokenSymbol: string;
    tokenDecimals: number;
    receivingAddress: string;
    minimumAtomicAmount: string;
    maximumAtomicAmount: string;
  }>,
): ReturnType<typeof botChainRuntimeCapabilitySchema.safeParse> {
  return botChainRuntimeCapabilitySchema.safeParse({
    ...input,
    mode: 'DIRECT_ERC20',
    source: 'STATIC_CONFIG',
    chainId: resolveBotChainNetwork(input.environment).chainId,
    discoveredAt: new Date().toISOString(),
  });
}
