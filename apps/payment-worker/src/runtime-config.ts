import {
  parseBotChainMerchantCapability,
  resolveBotChainRpcUrl,
  type BotChainRuntimeCapability,
} from '@shipyard402/bot-chain-network-config';
import {
  ConfigurationError,
  GOAT_X402_ALL_ENV_NAMES,
  assertPostgresUrl,
  parseBoundedInt,
  parseMerchantCapability,
  resolveGoatMerchantProfile,
  resolveRpcUrl,
  type FlowRuntimeCapability,
} from '@shipyard402/goat-network-config';
import { z } from 'zod';

const goatMerchantEnvironmentShape = Object.fromEntries(
  GOAT_X402_ALL_ENV_NAMES.map((name) => [
    name,
    name.endsWith('_API_URL') ? z.string().url().optional() : z.string().optional(),
  ]),
) as Record<(typeof GOAT_X402_ALL_ENV_NAMES)[number], z.ZodOptional<z.ZodString>>;

const environmentSchema = z
  .object({
    APP_ENV: z.enum(['development', 'test', 'production']).default('development'),
    GOAT_NETWORK_ENVIRONMENT: z.enum(['mainnet', 'testnet3']).default('mainnet'),
    DATABASE_URL: z.string().optional(),
    DATABASE_TLS: z.enum(['true', 'false']).optional(),
    GOAT_MAINNET_RPC_URL: z.string().url().optional(),
    GOAT_TESTNET_RPC_URL: z.string().url().optional(),
    // Required as a complete selected-network group only when the GOAT adapter is active.
    ...goatMerchantEnvironmentShape,
    // Selects which merchant adapter this process runs. Defaults to 'goat-flow' so an unset env
    // var reproduces today's exact behavior. Mirrors apps/api-gateway/src/runtime-config.ts.
    MERCHANT_ADAPTER: z.enum(['goat-flow', 'bot-chain-direct']).default('goat-flow'),
    BOT_NETWORK_ENVIRONMENT: z.literal('botChainTestnet').default('botChainTestnet'),
    BOTCHAIN_TESTNET_RPC_URL: z.string().url().optional(),
    BOTX402_MERCHANT_ID: z.string().min(1).optional(),
    BOTX402_TOKEN_ADDRESS: z.string().min(1).optional(),
    BOTX402_TOKEN_SYMBOL: z.string().min(1).optional(),
    BOTX402_TOKEN_DECIMALS: z.string().min(1).optional(),
    BOTX402_RECEIVING_ADDRESS: z.string().min(1).optional(),
    BOTX402_MINIMUM_ATOMIC_AMOUNT: z.string().min(1).optional(),
    BOTX402_MAXIMUM_ATOMIC_AMOUNT: z.string().min(1).optional(),
    PAYMENT_WORKER_ID: z
      .string()
      .regex(/^[a-zA-Z0-9:_-]{1,200}$/)
      .optional(),
    PAYMENT_POLL_INTERVAL_MS: z.string().regex(/^\d+$/).optional(),
    PAYMENT_LEASE_SECONDS: z.string().regex(/^\d+$/).optional(),
  })
  .strict();

const selectedNames = [
  'APP_ENV',
  'GOAT_NETWORK_ENVIRONMENT',
  'DATABASE_URL',
  'DATABASE_TLS',
  'GOAT_MAINNET_RPC_URL',
  'GOAT_TESTNET_RPC_URL',
  ...GOAT_X402_ALL_ENV_NAMES,
  'MERCHANT_ADAPTER',
  'BOT_NETWORK_ENVIRONMENT',
  'BOTCHAIN_TESTNET_RPC_URL',
  'BOTX402_MERCHANT_ID',
  'BOTX402_TOKEN_ADDRESS',
  'BOTX402_TOKEN_SYMBOL',
  'BOTX402_TOKEN_DECIMALS',
  'BOTX402_RECEIVING_ADDRESS',
  'BOTX402_MINIMUM_ATOMIC_AMOUNT',
  'BOTX402_MAXIMUM_ATOMIC_AMOUNT',
  'PAYMENT_WORKER_ID',
  'PAYMENT_POLL_INTERVAL_MS',
  'PAYMENT_LEASE_SECONDS',
] as const;

const botMerchantFieldNames = [
  'BOTX402_MERCHANT_ID',
  'BOTX402_TOKEN_ADDRESS',
  'BOTX402_TOKEN_SYMBOL',
  'BOTX402_TOKEN_DECIMALS',
  'BOTX402_RECEIVING_ADDRESS',
  'BOTX402_MINIMUM_ATOMIC_AMOUNT',
  'BOTX402_MAXIMUM_ATOMIC_AMOUNT',
] as const;
type BotMerchantFieldName = (typeof botMerchantFieldNames)[number];

export type PaymentWorkerRuntimeConfig = Readonly<{
  database: Readonly<{ connectionString: string; useTls: boolean }>;
  workerId: string;
  pollIntervalMilliseconds: number;
  leaseDurationSeconds: number;
  merchantAdapter: 'goat-flow' | 'bot-chain-direct';
  goatEnvironment?: 'mainnet' | 'testnet3';
  rpcUrl?: string;
  merchant?: Readonly<{
    merchantId: string;
    apiKey: string;
    apiSecret: string;
    capability: FlowRuntimeCapability;
  }>;
  botChainRpcUrl?: string;
  botChainMerchant?: Readonly<{
    merchantId: string;
    capability: BotChainRuntimeCapability;
  }>;
}>;

export class PaymentWorkerConfigurationError extends ConfigurationError {
  constructor(message: string, fields: readonly string[]) {
    super(message, fields);
    this.name = 'PaymentWorkerConfigurationError';
  }
}

function throwPaymentWorkerConfigurationError(message: string, fields: readonly string[]): never {
  throw new PaymentWorkerConfigurationError(message, fields);
}

export function parsePaymentWorkerRuntimeConfig(environment: NodeJS.ProcessEnv): PaymentWorkerRuntimeConfig {
  const selected = Object.fromEntries(selectedNames.map((name) => [name, environment[name]]));
  const parsed = environmentSchema.safeParse(selected);
  if (!parsed.success) {
    throw new PaymentWorkerConfigurationError(
      'Payment worker configuration is incomplete or invalid',
      parsed.error.issues.map((issue) => issue.path.join('.')).filter(Boolean),
    );
  }
  const values = parsed.data;
  const connectionString =
    values.DATABASE_URL ??
    (values.APP_ENV === 'production' ? undefined : 'postgresql://shipyard:shipyard@127.0.0.1:5432/shipyard');
  if (!connectionString) {
    throw new PaymentWorkerConfigurationError('Production payment worker requires PostgreSQL', ['DATABASE_URL']);
  }
  assertPostgresUrl(connectionString, throwPaymentWorkerConfigurationError);

  const pollIntervalMilliseconds = parseBoundedInt(values.PAYMENT_POLL_INTERVAL_MS, '2000', { min: 250, max: 60_000 });
  if (pollIntervalMilliseconds === undefined) {
    throw new PaymentWorkerConfigurationError('Payment poll interval must be between 250 and 60000 milliseconds', [
      'PAYMENT_POLL_INTERVAL_MS',
    ]);
  }
  const leaseDurationSeconds = parseBoundedInt(values.PAYMENT_LEASE_SECONDS, '60', { min: 5, max: 600 });
  if (leaseDurationSeconds === undefined) {
    throw new PaymentWorkerConfigurationError('Payment lease must be between 5 and 600 seconds', [
      'PAYMENT_LEASE_SECONDS',
    ]);
  }

  const shared = {
    database: {
      connectionString,
      useTls: values.DATABASE_TLS ? values.DATABASE_TLS === 'true' : values.APP_ENV === 'production',
    },
    workerId: values.PAYMENT_WORKER_ID ?? `payment-worker:${process.pid}`,
    pollIntervalMilliseconds,
    leaseDurationSeconds,
  };

  if (values.MERCHANT_ADAPTER === 'bot-chain-direct') {
    const missing = botMerchantFieldNames.filter((field) => values[field] === undefined);
    if (missing.length > 0) {
      throw new PaymentWorkerConfigurationError('BOT Chain merchant configuration is incomplete', missing);
    }
    const required = values as typeof values & Record<BotMerchantFieldName, string>;
    const botChainRpcUrl = resolveBotChainRpcUrl(
      values.BOT_NETWORK_ENVIRONMENT,
      { testnetRpcUrl: values.BOTCHAIN_TESTNET_RPC_URL },
      throwPaymentWorkerConfigurationError,
    );
    const capability = parseBotChainMerchantCapability({
      environment: values.BOT_NETWORK_ENVIRONMENT,
      merchantId: required.BOTX402_MERCHANT_ID,
      tokenAddress: required.BOTX402_TOKEN_ADDRESS,
      tokenSymbol: required.BOTX402_TOKEN_SYMBOL,
      tokenDecimals: Number(required.BOTX402_TOKEN_DECIMALS),
      receivingAddress: required.BOTX402_RECEIVING_ADDRESS,
      minimumAtomicAmount: required.BOTX402_MINIMUM_ATOMIC_AMOUNT,
      maximumAtomicAmount: required.BOTX402_MAXIMUM_ATOMIC_AMOUNT,
    });
    if (!capability.success) {
      throw new PaymentWorkerConfigurationError(
        'Reviewed BOT Chain merchant capability is invalid',
        capability.error.issues.map((issue) => issue.path.join('.')).filter(Boolean),
      );
    }
    return {
      ...shared,
      merchantAdapter: 'bot-chain-direct',
      botChainRpcUrl,
      botChainMerchant: { merchantId: required.BOTX402_MERCHANT_ID, capability: capability.data },
    };
  }

  if (values.APP_ENV === 'production' && values.GOAT_NETWORK_ENVIRONMENT !== 'mainnet') {
    throw new PaymentWorkerConfigurationError('Production payment worker must use GOAT mainnet', [
      'GOAT_NETWORK_ENVIRONMENT',
    ]);
  }
  const rpcUrl = resolveRpcUrl(
    values.GOAT_NETWORK_ENVIRONMENT,
    { mainnetRpcUrl: values.GOAT_MAINNET_RPC_URL, testnetRpcUrl: values.GOAT_TESTNET_RPC_URL },
    throwPaymentWorkerConfigurationError,
  );
  const goatProfile = resolveGoatMerchantProfile(
    values.GOAT_NETWORK_ENVIRONMENT,
    selected,
    throwPaymentWorkerConfigurationError,
  );
  if (!goatProfile.merchant) {
    throw new PaymentWorkerConfigurationError(
      'GOAT x402 merchant configuration is incomplete',
      goatProfile.expectedMerchantFields,
    );
  }
  const requiredGoat = goatProfile.merchant;
  const capability = parseMerchantCapability({
    environment: values.GOAT_NETWORK_ENVIRONMENT,
    merchantId: requiredGoat.merchantId,
    tokenAddress: requiredGoat.tokenAddress,
    tokenSymbol: requiredGoat.tokenSymbol,
    tokenDecimals: Number(requiredGoat.tokenDecimals),
    receivingAddress: requiredGoat.receivingAddress,
    minimumAtomicAmount: requiredGoat.minimumAtomicAmount,
    maximumAtomicAmount: requiredGoat.maximumAtomicAmount,
    source: 'PORTAL_REVIEW',
  });
  if (!capability.success) {
    throw new PaymentWorkerConfigurationError(
      'Reviewed GOAT merchant capability is invalid',
      capability.error.issues.map((issue) => issue.path.join('.')).filter(Boolean),
    );
  }

  return {
    ...shared,
    merchantAdapter: 'goat-flow',
    goatEnvironment: values.GOAT_NETWORK_ENVIRONMENT,
    rpcUrl,
    merchant: {
      merchantId: requiredGoat.merchantId,
      apiKey: requiredGoat.apiKey,
      apiSecret: requiredGoat.apiSecret,
      capability: capability.data,
    },
  };
}
