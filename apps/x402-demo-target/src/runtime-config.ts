import { BOT_CHAIN_TESTNET, resolveBotChainRpcUrl } from '@shipyard402/bot-chain-network-config';
import { ConfigurationError, resolveNetwork, resolveRpcUrl } from '@shipyard402/goat-network-config';
import { z } from 'zod';

const environmentSchema = z
  .object({
    HOST: z.string().min(1).default('127.0.0.1'),
    PORT: z.string().regex(/^\d+$/).default('3002'),
    DEMO_MODE: z.enum(['V1_VULNERABLE', 'V2_PROTECTED']),
    // Which chain this target settles on. Defaults to 'goat', reproducing today's exact behavior
    // when unset -- GOAT_NETWORK_ENVIRONMENT keeps selecting mainnet vs Testnet3 in that mode.
    NETWORK: z.enum(['goat', 'bot-chain-testnet']).default('goat'),
    GOAT_NETWORK_ENVIRONMENT: z.enum(['mainnet', 'testnet3']).default('testnet3'),
    GOAT_MAINNET_RPC_URL: z.string().url().optional(),
    GOAT_TESTNET_RPC_URL: z.string().url().optional(),
    BOTCHAIN_TESTNET_RPC_URL: z.string().url().optional(),
    // The EIP-3009 settlement asset and its EIP-712 domain -- what a payer signs against.
    DEMO_TARGET_TOKEN_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    DEMO_TARGET_TOKEN_NAME: z.string().min(1).default('Shipyard Testnet Token'),
    DEMO_TARGET_TOKEN_VERSION: z.string().min(1).default('1'),
    DEMO_TARGET_RECEIVING_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    DEMO_TARGET_PRICE_ATOMIC: z.string().regex(/^[1-9]\d*$/),
    DEMO_TARGET_MAX_TIMEOUT_SECONDS: z.string().regex(/^\d+$/).default('300'),
    // Funds gas to submit transferWithAuthorization. This account never holds the payer's balance;
    // it only relays the payer's signed authorization on-chain.
    DEMO_TARGET_SETTLER_PRIVATE_KEY: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
    PROVIDER_SIGNER_PRIVATE_KEY: z
      .string()
      .regex(/^0x[a-fA-F0-9]{64}$/)
      .optional(),
  })
  .strict();

const selectedNames = [
  'HOST',
  'PORT',
  'DEMO_MODE',
  'NETWORK',
  'GOAT_NETWORK_ENVIRONMENT',
  'GOAT_MAINNET_RPC_URL',
  'GOAT_TESTNET_RPC_URL',
  'BOTCHAIN_TESTNET_RPC_URL',
  'DEMO_TARGET_TOKEN_ADDRESS',
  'DEMO_TARGET_TOKEN_NAME',
  'DEMO_TARGET_TOKEN_VERSION',
  'DEMO_TARGET_RECEIVING_ADDRESS',
  'DEMO_TARGET_PRICE_ATOMIC',
  'DEMO_TARGET_MAX_TIMEOUT_SECONDS',
  'DEMO_TARGET_SETTLER_PRIVATE_KEY',
  'PROVIDER_SIGNER_PRIVATE_KEY',
] as const;

export type DemoTargetRuntimeConfig = Readonly<{
  host: string;
  port: number;
  mode: 'V1_VULNERABLE' | 'V2_PROTECTED';
  network: 'goat' | 'bot-chain-testnet';
  goatEnvironment: 'mainnet' | 'testnet3';
  rpcUrl: string;
  chainId: number;
  tokenAddress: `0x${string}`;
  tokenName: string;
  tokenVersion: string;
  receivingAddress: `0x${string}`;
  priceAtomic: string;
  maxTimeoutSeconds: number;
  settlerPrivateKey: `0x${string}`;
  providerSignerPrivateKey?: `0x${string}`;
}>;

export class DemoTargetConfigurationError extends ConfigurationError {
  constructor(message: string, fields: readonly string[]) {
    super(message, fields);
    this.name = 'DemoTargetConfigurationError';
  }
}

function throwDemoTargetConfigurationError(message: string, fields: readonly string[]): never {
  throw new DemoTargetConfigurationError(message, fields);
}

export function parseDemoTargetRuntimeConfig(environment: NodeJS.ProcessEnv): DemoTargetRuntimeConfig {
  const selected = Object.fromEntries(selectedNames.map((name) => [name, environment[name]]));
  const parsed = environmentSchema.safeParse(selected);
  if (!parsed.success) {
    throw new DemoTargetConfigurationError(
      'x402 demo target configuration is incomplete or invalid',
      parsed.error.issues.map((issue) => issue.path.join('.')).filter(Boolean),
    );
  }
  const values = parsed.data;
  const rpcUrl =
    values.NETWORK === 'bot-chain-testnet'
      ? resolveBotChainRpcUrl(
          'botChainTestnet',
          { testnetRpcUrl: values.BOTCHAIN_TESTNET_RPC_URL },
          throwDemoTargetConfigurationError,
        )
      : resolveRpcUrl(
          values.GOAT_NETWORK_ENVIRONMENT,
          { mainnetRpcUrl: values.GOAT_MAINNET_RPC_URL, testnetRpcUrl: values.GOAT_TESTNET_RPC_URL },
          throwDemoTargetConfigurationError,
        );
  const chainId =
    values.NETWORK === 'bot-chain-testnet'
      ? BOT_CHAIN_TESTNET.chainId
      : resolveNetwork(values.GOAT_NETWORK_ENVIRONMENT).chainId;

  return {
    host: values.HOST,
    port: Number(values.PORT),
    mode: values.DEMO_MODE,
    network: values.NETWORK,
    goatEnvironment: values.GOAT_NETWORK_ENVIRONMENT,
    rpcUrl,
    chainId,
    tokenAddress: values.DEMO_TARGET_TOKEN_ADDRESS as `0x${string}`,
    tokenName: values.DEMO_TARGET_TOKEN_NAME,
    tokenVersion: values.DEMO_TARGET_TOKEN_VERSION,
    receivingAddress: values.DEMO_TARGET_RECEIVING_ADDRESS as `0x${string}`,
    priceAtomic: values.DEMO_TARGET_PRICE_ATOMIC,
    maxTimeoutSeconds: Number(values.DEMO_TARGET_MAX_TIMEOUT_SECONDS),
    settlerPrivateKey: values.DEMO_TARGET_SETTLER_PRIVATE_KEY as `0x${string}`,
    ...(values.PROVIDER_SIGNER_PRIVATE_KEY
      ? { providerSignerPrivateKey: values.PROVIDER_SIGNER_PRIVATE_KEY as `0x${string}` }
      : {}),
  };
}
