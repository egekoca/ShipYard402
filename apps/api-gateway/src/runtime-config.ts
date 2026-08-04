import { GOAT_MAINNET, flowRuntimeCapabilitySchema, type FlowRuntimeCapability } from '@shipyard402/goat-network-config';
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
  host: string;
  port: number;
  allowedWebOrigins: readonly string[];
  database: Readonly<{
    connectionString: string;
    useTls: boolean;
  }>;
  merchant?: MerchantRuntimeConfig;
}>;

export class RuntimeConfigurationError extends Error {
  readonly fields: readonly string[];

  constructor(message: string, fields: readonly string[]) {
    super(message);
    this.name = 'RuntimeConfigurationError';
    this.fields = fields;
  }
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
  assertPostgresUrl(connectionString);

  if (values.GOATX402_API_URL) assertReviewedApiUrl(values.GOATX402_API_URL);

  const merchant = parseMerchantConfig(values);
  if (values.APP_ENV === 'production' && !merchant) {
    throw new RuntimeConfigurationError(
      'Production requires complete reviewed GOAT x402 merchant configuration',
      [...merchantFieldNames],
    );
  }

  const origins = (values.WEB_ORIGIN ?? 'http://127.0.0.1:3000')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map(validateWebOrigin);

  return {
    environment: values.APP_ENV,
    host: values.API_HOST ?? (values.APP_ENV === 'production' ? '0.0.0.0' : '127.0.0.1'),
    port,
    allowedWebOrigins: origins,
    database: {
      connectionString,
      useTls: values.DATABASE_TLS ? values.DATABASE_TLS === 'true' : values.APP_ENV === 'production',
    },
    ...(merchant ? { merchant } : {}),
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
  const tokenDecimals = Number(required.GOATX402_TOKEN_DECIMALS);
  const candidate = flowRuntimeCapabilitySchema.safeParse({
    environment: 'mainnet',
    merchantId: required.GOATX402_MERCHANT_ID,
    mode: 'ERC20_DIRECT',
    chainId: GOAT_MAINNET.chainId,
    tokenAddress: required.GOATX402_TOKEN_ADDRESS,
    tokenSymbol: required.GOATX402_TOKEN_SYMBOL,
    tokenDecimals,
    receivingAddress: required.GOATX402_RECEIVING_ADDRESS,
    minimumAtomicAmount: required.GOATX402_MINIMUM_ATOMIC_AMOUNT,
    maximumAtomicAmount: required.GOATX402_MAXIMUM_ATOMIC_AMOUNT,
    discoveredAt: new Date().toISOString(),
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

function assertPostgresUrl(value: string): void {
  try {
    const parsed = new URL(value);
    if (!['postgresql:', 'postgres:'].includes(parsed.protocol) || !parsed.hostname || !parsed.pathname.slice(1)) {
      throw new Error('invalid');
    }
  } catch {
    throw new RuntimeConfigurationError('DATABASE_URL must be a PostgreSQL connection URL', ['DATABASE_URL']);
  }
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

function assertReviewedApiUrl(value: string): void {
  const parsed = new URL(value);
  if (
    parsed.origin !== GOAT_MAINNET.x402ApiUrl ||
    parsed.username ||
    parsed.password ||
    !['', '/'].includes(parsed.pathname) ||
    parsed.search ||
    parsed.hash
  ) {
    throw new RuntimeConfigurationError('GOAT x402 API origin must match the reviewed mainnet origin', ['GOATX402_API_URL']);
  }
}
