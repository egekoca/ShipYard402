import {
  ConfigurationError,
  assertPostgresUrl,
  parseMerchantCapability,
  resolveNetwork,
  type FlowRuntimeCapability,
} from '@shipyard402/goat-network-config';
import { z } from 'zod';

const LOCAL_DATABASE_URL = 'postgresql://shipyard:shipyard@127.0.0.1:5432/shipyard';

const selectedEnvironmentSchema = z
  .object({
    APP_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_HOST: z.string().min(1).optional(),
    PORT: z.string().regex(/^\d+$/).optional(),
    WEB_ORIGIN: z.string().optional(),
    DATABASE_URL: z.string().optional(),
    DATABASE_TLS: z.enum(['true', 'false']).optional(),
    GOAT_NETWORK_ENVIRONMENT: z.enum(['mainnet', 'testnet3']).default('mainnet'),
    GOATX402_API_URL: z.string().url().optional(),
    GOATX402_MERCHANT_ID: z.string().min(1).optional(),
    GOATX402_API_KEY: z.string().min(1).optional(),
    GOATX402_API_SECRET: z.string().min(1).optional(),
    GOATX402_TOKEN_ADDRESS: z.string().optional(),
    GOATX402_TOKEN_SYMBOL: z.string().optional(),
    GOATX402_TOKEN_DECIMALS: z.string().optional(),
    GOATX402_RECEIVING_ADDRESS: z.string().optional(),
    GOATX402_MINIMUM_ATOMIC_AMOUNT: z.string().optional(),
    GOATX402_MAXIMUM_ATOMIC_AMOUNT: z.string().optional(),
    SESSION_SIGNING_SECRET: z.string().min(32).optional(),
  })
  .strict();

const merchantFieldNames = [
  'GOATX402_MERCHANT_ID',
  'GOATX402_API_KEY',
  'GOATX402_API_SECRET',
  'GOATX402_TOKEN_ADDRESS',
  'GOATX402_TOKEN_SYMBOL',
  'GOATX402_TOKEN_DECIMALS',
  'GOATX402_RECEIVING_ADDRESS',
  'GOATX402_MINIMUM_ATOMIC_AMOUNT',
  'GOATX402_MAXIMUM_ATOMIC_AMOUNT',
] as const;

type MerchantFieldName = (typeof merchantFieldNames)[number];
type SelectedEnvironment = z.infer<typeof selectedEnvironmentSchema>;

export type MerchantRuntimeConfig = Readonly<{
  merchantId: string;
  apiKey: string;
  apiSecret: string;
  capability: FlowRuntimeCapability;
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
  merchant?: MerchantRuntimeConfig;
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
  if (values.GOATX402_API_URL) assertReviewedApiUrl(values.GOATX402_API_URL, values.GOAT_NETWORK_ENVIRONMENT);

  const merchant = parseMerchantConfig(values);
  if (values.APP_ENV === 'production' && !merchant) {
    throw new RuntimeConfigurationError(
      'Production requires complete reviewed GOAT x402 merchant configuration',
      [...merchantFieldNames],
    );
  }
  if (values.APP_ENV === 'production' && !values.SESSION_SIGNING_SECRET) {
    throw new RuntimeConfigurationError(
      'Production requires SESSION_SIGNING_SECRET so run/quote ownership can actually be verified',
      ['SESSION_SIGNING_SECRET'],
    );
  }

  const origins = (values.WEB_ORIGIN ?? 'http://127.0.0.1:3000')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map(validateWebOrigin);

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
    ...(merchant ? { merchant } : {}),
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
    GOATX402_API_URL: environment['GOATX402_API_URL'],
    GOATX402_MERCHANT_ID: environment['GOATX402_MERCHANT_ID'],
    GOATX402_API_KEY: environment['GOATX402_API_KEY'],
    GOATX402_API_SECRET: environment['GOATX402_API_SECRET'],
    GOATX402_TOKEN_ADDRESS: environment['GOATX402_TOKEN_ADDRESS'],
    GOATX402_TOKEN_SYMBOL: environment['GOATX402_TOKEN_SYMBOL'],
    GOATX402_TOKEN_DECIMALS: environment['GOATX402_TOKEN_DECIMALS'],
    GOATX402_RECEIVING_ADDRESS: environment['GOATX402_RECEIVING_ADDRESS'],
    GOATX402_MINIMUM_ATOMIC_AMOUNT: environment['GOATX402_MINIMUM_ATOMIC_AMOUNT'],
    GOATX402_MAXIMUM_ATOMIC_AMOUNT: environment['GOATX402_MAXIMUM_ATOMIC_AMOUNT'],
    SESSION_SIGNING_SECRET: environment['SESSION_SIGNING_SECRET'],
  };
}

function parseMerchantConfig(values: SelectedEnvironment): MerchantRuntimeConfig | undefined {
  const provided = merchantFieldNames.filter((field) => values[field] !== undefined);
  if (provided.length === 0) return undefined;
  if (provided.length !== merchantFieldNames.length) {
    const missing = merchantFieldNames.filter((field) => values[field] === undefined);
    throw new RuntimeConfigurationError('GOAT x402 merchant configuration must be provided as one complete group', missing);
  }

  const required = values as SelectedEnvironment & Record<MerchantFieldName, string>;
  const candidate = parseMerchantCapability({
    environment: values.GOAT_NETWORK_ENVIRONMENT,
    merchantId: required.GOATX402_MERCHANT_ID,
    tokenAddress: required.GOATX402_TOKEN_ADDRESS,
    tokenSymbol: required.GOATX402_TOKEN_SYMBOL,
    tokenDecimals: Number(required.GOATX402_TOKEN_DECIMALS),
    receivingAddress: required.GOATX402_RECEIVING_ADDRESS,
    minimumAtomicAmount: required.GOATX402_MINIMUM_ATOMIC_AMOUNT,
    maximumAtomicAmount: required.GOATX402_MAXIMUM_ATOMIC_AMOUNT,
    source: 'PORTAL_REVIEW',
  });
  if (!candidate.success) {
    throw new RuntimeConfigurationError(
      'Reviewed GOAT x402 merchant capability is invalid',
      candidate.error.issues.map((issue) => issue.path.join('.')).filter(Boolean),
    );
  }

  return {
    merchantId: required.GOATX402_MERCHANT_ID,
    apiKey: required.GOATX402_API_KEY,
    apiSecret: required.GOATX402_API_SECRET,
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

function assertReviewedApiUrl(value: string, environment: 'mainnet' | 'testnet3'): void {
  const parsed = new URL(value);
  const expected = resolveNetwork(environment).flowApiUrl;
  if (
    parsed.origin !== expected ||
    parsed.username ||
    parsed.password ||
    !['', '/'].includes(parsed.pathname) ||
    parsed.search ||
    parsed.hash
  ) {
    throw new RuntimeConfigurationError(
      `GOAT x402 API origin must match the reviewed ${environment} origin`,
      ['GOATX402_API_URL'],
    );
  }
}
