import { GOAT_MAINNET, flowRuntimeCapabilitySchema, type FlowRuntimeCapability } from '@shipyard402/goat-network-config';
import { z } from 'zod';

const environmentSchema = z.object({
  APP_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().optional(),
  DATABASE_TLS: z.enum(['true', 'false']).optional(),
  GOAT_MAINNET_RPC_URL: z.string().url().optional(),
  GOATX402_API_URL: z.string().url().optional(),
  GOATX402_MERCHANT_ID: z.string().min(1),
  GOATX402_API_KEY: z.string().min(1),
  GOATX402_API_SECRET: z.string().min(1),
  GOATX402_TOKEN_ADDRESS: z.string().min(1),
  GOATX402_TOKEN_SYMBOL: z.string().min(1),
  GOATX402_TOKEN_DECIMALS: z.string().min(1),
  GOATX402_RECEIVING_ADDRESS: z.string().min(1),
  GOATX402_MINIMUM_ATOMIC_AMOUNT: z.string().min(1),
  GOATX402_MAXIMUM_ATOMIC_AMOUNT: z.string().min(1),
  PAYMENT_WORKER_ID: z.string().regex(/^[a-zA-Z0-9:_-]{1,200}$/).optional(),
  PAYMENT_POLL_INTERVAL_MS: z.string().regex(/^\d+$/).optional(),
  PAYMENT_LEASE_SECONDS: z.string().regex(/^\d+$/).optional(),
}).strict();

const selectedNames = [
  'APP_ENV', 'DATABASE_URL', 'DATABASE_TLS', 'GOAT_MAINNET_RPC_URL', 'GOATX402_API_URL',
  'GOATX402_MERCHANT_ID', 'GOATX402_API_KEY', 'GOATX402_API_SECRET',
  'GOATX402_TOKEN_ADDRESS', 'GOATX402_TOKEN_SYMBOL', 'GOATX402_TOKEN_DECIMALS',
  'GOATX402_RECEIVING_ADDRESS', 'GOATX402_MINIMUM_ATOMIC_AMOUNT', 'GOATX402_MAXIMUM_ATOMIC_AMOUNT',
  'PAYMENT_WORKER_ID', 'PAYMENT_POLL_INTERVAL_MS', 'PAYMENT_LEASE_SECONDS',
] as const;

export type PaymentWorkerRuntimeConfig = Readonly<{
  database: Readonly<{ connectionString: string; useTls: boolean }>;
  rpcUrl: string;
  workerId: string;
  pollIntervalMilliseconds: number;
  leaseDurationSeconds: number;
  merchant: Readonly<{
    merchantId: string;
    apiKey: string;
    apiSecret: string;
    capability: FlowRuntimeCapability;
  }>;
}>;

export class PaymentWorkerConfigurationError extends Error {
  readonly fields: readonly string[];

  constructor(message: string, fields: readonly string[]) {
    super(message);
    this.name = 'PaymentWorkerConfigurationError';
    this.fields = fields;
  }
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
  const connectionString = values.DATABASE_URL ?? (
    values.APP_ENV === 'production' ? undefined : 'postgresql://shipyard:shipyard@127.0.0.1:5432/shipyard'
  );
  if (!connectionString) {
    throw new PaymentWorkerConfigurationError('Production payment worker requires PostgreSQL', ['DATABASE_URL']);
  }
  assertPostgresUrl(connectionString);
  const rpcUrl = values.GOAT_MAINNET_RPC_URL ?? GOAT_MAINNET.publicRpcUrl;
  assertExactUrl(rpcUrl, GOAT_MAINNET.publicRpcUrl, 'GOAT_MAINNET_RPC_URL');
  if (values.GOATX402_API_URL) assertExactUrl(values.GOATX402_API_URL, GOAT_MAINNET.x402ApiUrl, 'GOATX402_API_URL');

  const pollIntervalMilliseconds = Number(values.PAYMENT_POLL_INTERVAL_MS ?? '2000');
  if (!Number.isSafeInteger(pollIntervalMilliseconds) || pollIntervalMilliseconds < 250 || pollIntervalMilliseconds > 60_000) {
    throw new PaymentWorkerConfigurationError('Payment poll interval must be between 250 and 60000 milliseconds', ['PAYMENT_POLL_INTERVAL_MS']);
  }
  const leaseDurationSeconds = Number(values.PAYMENT_LEASE_SECONDS ?? '60');
  if (!Number.isSafeInteger(leaseDurationSeconds) || leaseDurationSeconds < 5 || leaseDurationSeconds > 600) {
    throw new PaymentWorkerConfigurationError('Payment lease must be between 5 and 600 seconds', ['PAYMENT_LEASE_SECONDS']);
  }

  const capability = flowRuntimeCapabilitySchema.safeParse({
    environment: 'mainnet',
    merchantId: values.GOATX402_MERCHANT_ID,
    mode: 'ERC20_DIRECT',
    chainId: GOAT_MAINNET.chainId,
    tokenAddress: values.GOATX402_TOKEN_ADDRESS,
    tokenSymbol: values.GOATX402_TOKEN_SYMBOL,
    tokenDecimals: Number(values.GOATX402_TOKEN_DECIMALS),
    receivingAddress: values.GOATX402_RECEIVING_ADDRESS,
    minimumAtomicAmount: values.GOATX402_MINIMUM_ATOMIC_AMOUNT,
    maximumAtomicAmount: values.GOATX402_MAXIMUM_ATOMIC_AMOUNT,
    discoveredAt: new Date().toISOString(),
    source: 'PORTAL_REVIEW',
  });
  if (!capability.success) {
    throw new PaymentWorkerConfigurationError(
      'Reviewed GOAT merchant capability is invalid',
      capability.error.issues.map((issue) => issue.path.join('.')).filter(Boolean),
    );
  }

  return {
    database: {
      connectionString,
      useTls: values.DATABASE_TLS ? values.DATABASE_TLS === 'true' : values.APP_ENV === 'production',
    },
    rpcUrl,
    workerId: values.PAYMENT_WORKER_ID ?? `payment-worker:${process.pid}`,
    pollIntervalMilliseconds,
    leaseDurationSeconds,
    merchant: {
      merchantId: values.GOATX402_MERCHANT_ID,
      apiKey: values.GOATX402_API_KEY,
      apiSecret: values.GOATX402_API_SECRET,
      capability: capability.data,
    },
  };
}

function assertPostgresUrl(value: string): void {
  try {
    const parsed = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname || !parsed.pathname.slice(1)) {
      throw new Error('invalid');
    }
  } catch {
    throw new PaymentWorkerConfigurationError('DATABASE_URL must be a PostgreSQL URL', ['DATABASE_URL']);
  }
}

function assertExactUrl(value: string, expected: string, field: string): void {
  const parsed = new URL(value);
  if (
    parsed.origin !== expected || parsed.username || parsed.password ||
    !['', '/'].includes(parsed.pathname) || parsed.search || parsed.hash
  ) {
    throw new PaymentWorkerConfigurationError(`${field} must match the reviewed official origin`, [field]);
  }
}
