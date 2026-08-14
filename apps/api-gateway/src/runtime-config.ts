import { parseBotChainMerchantCapability, type BotChainRuntimeCapability } from '@shipyard402/bot-chain-network-config';
import {
  ConfigurationError,
  GOAT_X402_ALL_ENV_NAMES,
  assertPostgresUrl,
  parseMerchantCapability,
  resolveGoatMerchantProfile,
  type ResolvedGoatMerchantProfile,
  type FlowRuntimeCapability,
} from '@shipyard402/goat-network-config';
import { z } from 'zod';

const LOCAL_DATABASE_URL = 'postgresql://shipyard:shipyard@127.0.0.1:5432/shipyard';

const goatMerchantEnvironmentShape = Object.fromEntries(
  GOAT_X402_ALL_ENV_NAMES.map((name) => [
    name,
    name.endsWith('_API_URL') ? z.string().url().optional() : z.string().optional(),
  ]),
) as Record<(typeof GOAT_X402_ALL_ENV_NAMES)[number], z.ZodOptional<z.ZodString>>;

const selectedEnvironmentSchema = z
  .object({
    APP_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_HOST: z.string().min(1).optional(),
    PORT: z.string().regex(/^\d+$/).optional(),
    WEB_ORIGIN: z.string().optional(),
    DATABASE_URL: z.string().optional(),
    DATABASE_TLS: z.enum(['true', 'false']).optional(),
    GOAT_NETWORK_ENVIRONMENT: z.enum(['mainnet', 'testnet3']).default('mainnet'),
    ...goatMerchantEnvironmentShape,
    // Selects which merchant adapter this process runs -- 'goat-flow' (default, unchanged
    // behavior) talks to GOAT's own order/checkout API; 'bot-chain-direct' verifies payments
    // purely on-chain, for BOT Chain, which has no such API. One process runs exactly one
    // adapter, the same way one process already runs exactly one GOAT_NETWORK_ENVIRONMENT.
    MERCHANT_ADAPTER: z.enum(['goat-flow', 'bot-chain-direct']).default('goat-flow'),
    // Locked to testnet only for now -- BOT Chain mainnet is a deliberate later step, not
    // something an env var typo should be able to reach.
    BOT_NETWORK_ENVIRONMENT: z.literal('botChainTestnet').default('botChainTestnet'),
    BOTX402_MERCHANT_ID: z.string().min(1).optional(),
    BOTX402_TOKEN_ADDRESS: z.string().optional(),
    BOTX402_TOKEN_SYMBOL: z.string().optional(),
    BOTX402_TOKEN_DECIMALS: z.string().optional(),
    BOTX402_RECEIVING_ADDRESS: z.string().optional(),
    BOTX402_MINIMUM_ATOMIC_AMOUNT: z.string().optional(),
    BOTX402_MAXIMUM_ATOMIC_AMOUNT: z.string().optional(),
    SESSION_SIGNING_SECRET: z.string().min(32).optional(),
  })
  .strict();

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
type SelectedEnvironment = z.infer<typeof selectedEnvironmentSchema>;

export type MerchantRuntimeConfig = Readonly<{
  merchantId: string;
  apiKey: string;
  apiSecret: string;
  capability: FlowRuntimeCapability;
}>;

// No apiKey/apiSecret -- BOT Chain has no merchant API to authenticate against, so there is
// nothing to hold credentials for beyond the capability declaration itself.
export type BotChainMerchantRuntimeConfig = Readonly<{
  merchantId: string;
  capability: BotChainRuntimeCapability;
}>;

export type ApiRuntimeConfig = Readonly<{
  environment: 'development' | 'test' | 'production';
  goatEnvironment: 'mainnet' | 'testnet3';
  host: string;
  port: number;
  allowedWebOrigins: readonly string[];
  database: Readonly<{
    connectionString: string;
    useTls: boolean;
  }>;
  merchantAdapter: 'goat-flow' | 'bot-chain-direct';
  merchant?: MerchantRuntimeConfig;
  botChainMerchant?: BotChainMerchantRuntimeConfig;
  sessionSigningSecret?: string;
}>;

export class RuntimeConfigurationError extends ConfigurationError {
  constructor(message: string, fields: readonly string[]) {
    super(message, fields);
    this.name = 'RuntimeConfigurationError';
  }
}

function throwRuntimeConfigurationError(message: string, fields: readonly string[]): never {
  throw new RuntimeConfigurationError(message, fields);
}

export function parseRuntimeConfig(environment: NodeJS.ProcessEnv): ApiRuntimeConfig {
  const selected = selectEnvironment(environment);
  const parsed = selectedEnvironmentSchema.safeParse(selected);
  if (!parsed.success) {
    throw new RuntimeConfigurationError(
      'API runtime configuration is invalid',
      parsed.error.issues.map((issue) => issue.path.join('.')).filter(Boolean),
    );
  }

  const values = parsed.data;
  const port = Number(values.PORT ?? '3001');
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new RuntimeConfigurationError('API port is outside the valid range', ['PORT']);
  }

  const connectionString = values.DATABASE_URL ?? (values.APP_ENV === 'production' ? undefined : LOCAL_DATABASE_URL);
  if (!connectionString) {
    throw new RuntimeConfigurationError('Production requires durable PostgreSQL persistence', ['DATABASE_URL']);
  }
  assertPostgresUrl(connectionString, throwRuntimeConfigurationError);

  if (values.APP_ENV === 'production' && values.GOAT_NETWORK_ENVIRONMENT !== 'mainnet') {
    throw new RuntimeConfigurationError('Production API must use GOAT mainnet', ['GOAT_NETWORK_ENVIRONMENT']);
  }
  const goatProfile = resolveGoatMerchantProfile(
    values.GOAT_NETWORK_ENVIRONMENT,
    selected,
    throwRuntimeConfigurationError,
  );
  const merchant = parseMerchantConfig(values.GOAT_NETWORK_ENVIRONMENT, goatProfile.merchant);
  if (values.APP_ENV === 'production' && values.MERCHANT_ADAPTER === 'goat-flow' && !merchant) {
    throw new RuntimeConfigurationError('Production requires complete reviewed GOAT x402 merchant configuration', [
      ...goatProfile.expectedMerchantFields,
    ]);
  }
  const botChainMerchant = parseBotChainMerchantConfig(values);
  if (values.APP_ENV === 'production' && values.MERCHANT_ADAPTER === 'bot-chain-direct' && !botChainMerchant) {
    throw new RuntimeConfigurationError('Production requires complete reviewed BOT Chain x402 merchant configuration', [
      ...botMerchantFieldNames,
    ]);
  }
  if (values.APP_ENV === 'production' && !values.SESSION_SIGNING_SECRET) {
    throw new RuntimeConfigurationError(
      'Production requires SESSION_SIGNING_SECRET so run/quote ownership can actually be verified',
      ['SESSION_SIGNING_SECRET'],
    );
  }

  const configuredOrigins = (values.WEB_ORIGIN ?? 'http://127.0.0.1:3000')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map(validateWebOrigin);
  const origins =
    values.APP_ENV === 'production' ? configuredOrigins : expandLoopbackDevelopmentOrigins(configuredOrigins);

  return {
    environment: values.APP_ENV,
    goatEnvironment: values.GOAT_NETWORK_ENVIRONMENT,
    host: values.API_HOST ?? (values.APP_ENV === 'production' ? '0.0.0.0' : '127.0.0.1'),
    port,
    allowedWebOrigins: origins,
    database: {
      connectionString,
      useTls: values.DATABASE_TLS ? values.DATABASE_TLS === 'true' : values.APP_ENV === 'production',
    },
    merchantAdapter: values.MERCHANT_ADAPTER,
    ...(merchant ? { merchant } : {}),
    ...(botChainMerchant ? { botChainMerchant } : {}),
    ...(values.SESSION_SIGNING_SECRET ? { sessionSigningSecret: values.SESSION_SIGNING_SECRET } : {}),
  };
}

function selectEnvironment(environment: NodeJS.ProcessEnv): Record<string, string | undefined> {
  return {
    APP_ENV: environment['APP_ENV'],
    API_HOST: environment['API_HOST'],
    PORT: environment['PORT'],
    WEB_ORIGIN: environment['WEB_ORIGIN'],
    DATABASE_URL: environment['DATABASE_URL'],
    DATABASE_TLS: environment['DATABASE_TLS'],
    GOAT_NETWORK_ENVIRONMENT: environment['GOAT_NETWORK_ENVIRONMENT'],
    ...Object.fromEntries(GOAT_X402_ALL_ENV_NAMES.map((name) => [name, environment[name]])),
    MERCHANT_ADAPTER: environment['MERCHANT_ADAPTER'],
    BOT_NETWORK_ENVIRONMENT: environment['BOT_NETWORK_ENVIRONMENT'],
    BOTX402_MERCHANT_ID: environment['BOTX402_MERCHANT_ID'],
    BOTX402_TOKEN_ADDRESS: environment['BOTX402_TOKEN_ADDRESS'],
    BOTX402_TOKEN_SYMBOL: environment['BOTX402_TOKEN_SYMBOL'],
    BOTX402_TOKEN_DECIMALS: environment['BOTX402_TOKEN_DECIMALS'],
    BOTX402_RECEIVING_ADDRESS: environment['BOTX402_RECEIVING_ADDRESS'],
    BOTX402_MINIMUM_ATOMIC_AMOUNT: environment['BOTX402_MINIMUM_ATOMIC_AMOUNT'],
    BOTX402_MAXIMUM_ATOMIC_AMOUNT: environment['BOTX402_MAXIMUM_ATOMIC_AMOUNT'],
    SESSION_SIGNING_SECRET: environment['SESSION_SIGNING_SECRET'],
  };
}

function parseMerchantConfig(
  environment: 'mainnet' | 'testnet3',
  required: ResolvedGoatMerchantProfile['merchant'],
): MerchantRuntimeConfig | undefined {
  if (!required) return undefined;
  const candidate = parseMerchantCapability({
    environment,
    merchantId: required.merchantId,
    tokenAddress: required.tokenAddress,
    tokenSymbol: required.tokenSymbol,
    tokenDecimals: Number(required.tokenDecimals),
    receivingAddress: required.receivingAddress,
    minimumAtomicAmount: required.minimumAtomicAmount,
    maximumAtomicAmount: required.maximumAtomicAmount,
    source: 'PORTAL_REVIEW',
  });
  if (!candidate.success) {
    throw new RuntimeConfigurationError(
      'Reviewed GOAT x402 merchant capability is invalid',
      candidate.error.issues.map((issue) => issue.path.join('.')).filter(Boolean),
    );
  }

  return {
    merchantId: required.merchantId,
    apiKey: required.apiKey,
    apiSecret: required.apiSecret,
    capability: candidate.data,
  };
}

function parseBotChainMerchantConfig(values: SelectedEnvironment): BotChainMerchantRuntimeConfig | undefined {
  const provided = botMerchantFieldNames.filter((field) => values[field] !== undefined);
  if (provided.length === 0) return undefined;
  if (provided.length !== botMerchantFieldNames.length) {
    const missing = botMerchantFieldNames.filter((field) => values[field] === undefined);
    throw new RuntimeConfigurationError(
      'BOT Chain x402 merchant configuration must be provided as one complete group',
      missing,
    );
  }

  const required = values as SelectedEnvironment & Record<BotMerchantFieldName, string>;
  const candidate = parseBotChainMerchantCapability({
    environment: values.BOT_NETWORK_ENVIRONMENT,
    merchantId: required.BOTX402_MERCHANT_ID,
    tokenAddress: required.BOTX402_TOKEN_ADDRESS,
    tokenSymbol: required.BOTX402_TOKEN_SYMBOL,
    tokenDecimals: Number(required.BOTX402_TOKEN_DECIMALS),
    receivingAddress: required.BOTX402_RECEIVING_ADDRESS,
    minimumAtomicAmount: required.BOTX402_MINIMUM_ATOMIC_AMOUNT,
    maximumAtomicAmount: required.BOTX402_MAXIMUM_ATOMIC_AMOUNT,
  });
  if (!candidate.success) {
    throw new RuntimeConfigurationError(
      'Reviewed BOT Chain x402 merchant capability is invalid',
      candidate.error.issues.map((issue) => issue.path.join('.')).filter(Boolean),
    );
  }

  return {
    merchantId: required.BOTX402_MERCHANT_ID,
    capability: candidate.data,
  };
}

function validateWebOrigin(value: string): string {
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new Error('invalid');
    }
    return parsed.origin;
  } catch {
    throw new RuntimeConfigurationError('WEB_ORIGIN contains an invalid HTTP origin', ['WEB_ORIGIN']);
  }
}

/** Browsers treat localhost and 127.0.0.1 as different origins even though both reach the same
 * local service. Development servers are commonly opened through either spelling, so mirror only
 * loopback HTTP origins on the exact same port. Production remains an explicit, unchanged
 * allowlist and no non-loopback hostname is broadened. */
function expandLoopbackDevelopmentOrigins(origins: readonly string[]): readonly string[] {
  const expanded = new Set(origins);
  for (const origin of origins) {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:') continue;
    if (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') continue;

    parsed.hostname = parsed.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
    expanded.add(parsed.origin);
  }
  return [...expanded];
}
