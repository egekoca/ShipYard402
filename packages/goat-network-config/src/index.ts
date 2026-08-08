import { z } from 'zod';

export const GOAT_MAINNET = Object.freeze({
  chainId: 2345,
  chainIdHex: '0x929',
  name: 'GOAT Network',
  nativeCurrency: Object.freeze({ name: 'Bitcoin', symbol: 'BTC', decimals: 18 }),
  publicRpcUrl: 'https://rpc.goat.network',
  backupRpcUrl: 'https://rpc.ankr.com/goat_mainnet',
  explorerUrl: 'https://explorer.goat.network',
  flowApiUrl: 'https://flow-api.goat.network',
  flowMerchantUrl: 'https://flow-merchant.goat.network',
  flowQuickPayUrl: 'https://flow-quickpay.goat.network',
});

export const GOAT_TESTNET3 = Object.freeze({
  chainId: 48816,
  chainIdHex: '0xbeb0',
  name: 'GOAT Testnet3',
  nativeCurrency: Object.freeze({ name: 'Bitcoin', symbol: 'BTC', decimals: 18 }),
  publicRpcUrl: 'https://rpc.testnet3.goat.network',
  explorerUrl: 'https://explorer.testnet3.goat.network',
  flowApiUrl: 'https://flow-api.testnet3.goat.network',
  flowMerchantUrl: 'https://flow-merchant.testnet3.goat.network',
  flowQuickPayUrl: 'https://flow-quickpay.testnet3.goat.network',
});

export const flowRuntimeCapabilitySchema = z
  .object({
    environment: z.enum(['mainnet', 'testnet3']),
    merchantId: z.string().min(1),
    mode: z.literal('ERC20_DIRECT'),
    chainId: z.number().int().positive(),
    tokenAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    tokenSymbol: z.string().min(1).max(32),
    tokenDecimals: z.number().int().min(0).max(36),
    receivingAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    minimumAtomicAmount: z.string().regex(/^(0|[1-9]\d*)$/),
    maximumAtomicAmount: z.string().regex(/^(0|[1-9]\d*)$/),
    discoveredAt: z.string().datetime(),
    source: z.enum(['AUTHENTICATED_API', 'CHALLENGE', 'QUICKPAY_MANIFEST', 'PORTAL_REVIEW']),
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
    const expectedChain = capability.environment === 'mainnet' ? GOAT_MAINNET.chainId : GOAT_TESTNET3.chainId;
    if (capability.chainId !== expectedChain) {
      context.addIssue({
        code: 'custom',
        path: ['chainId'],
        message: `Chain does not match ${capability.environment}`,
      });
    }
  });

export type FlowRuntimeCapability = z.infer<typeof flowRuntimeCapabilitySchema>;

export type GoatNetwork = typeof GOAT_MAINNET | typeof GOAT_TESTNET3;

export function resolveNetwork(environment: 'mainnet' | 'testnet3'): GoatNetwork {
  return environment === 'mainnet' ? GOAT_MAINNET : GOAT_TESTNET3;
}

/** Base for the per-app `*ConfigurationError` classes: an `Error` carrying which env fields failed. */
export abstract class ConfigurationError extends Error {
  readonly fields: readonly string[];

  constructor(message: string, fields: readonly string[]) {
    super(message);
    this.fields = fields;
  }
}

type ErrorFactory = (message: string, fields: readonly string[]) => Error;

export function assertPostgresUrl(value: string, createError: ErrorFactory): void {
  let valid: boolean;
  try {
    const parsed = new URL(value);
    valid = ['postgres:', 'postgresql:'].includes(parsed.protocol) && !!parsed.hostname && !!parsed.pathname.slice(1);
  } catch {
    valid = false;
  }
  if (!valid) throw createError('DATABASE_URL must be a PostgreSQL connection URL', ['DATABASE_URL']);
}

export function assertExactUrl(value: string, expected: string, field: string, createError: ErrorFactory): void {
  const parsed = new URL(value);
  if (
    parsed.origin !== expected ||
    parsed.username ||
    parsed.password ||
    !['', '/'].includes(parsed.pathname) ||
    parsed.search ||
    parsed.hash
  ) {
    throw createError(`${field} must match the reviewed official origin`, [field]);
  }
}

/** Resolves the RPC URL for `environment`, applying an env override if present and validating it against the reviewed public origin. */
export function resolveRpcUrl(
  environment: 'mainnet' | 'testnet3',
  overrides: Readonly<{ mainnetRpcUrl?: string | undefined; testnetRpcUrl?: string | undefined }>,
  createError: ErrorFactory,
): string {
  const network = resolveNetwork(environment);
  const field = environment === 'mainnet' ? 'GOAT_MAINNET_RPC_URL' : 'GOAT_TESTNET_RPC_URL';
  const rpcUrl = (environment === 'mainnet' ? overrides.mainnetRpcUrl : overrides.testnetRpcUrl) ?? network.publicRpcUrl;
  assertExactUrl(rpcUrl, network.publicRpcUrl, field, createError);
  return rpcUrl;
}

/** Builds and validates a `FlowRuntimeCapability` from reviewed merchant fields, filling in chainId/mode/discoveredAt. */
export function parseMerchantCapability(
  input: Readonly<{
    environment: 'mainnet' | 'testnet3';
    merchantId: string;
    tokenAddress: string;
    tokenSymbol: string;
    tokenDecimals: number;
    receivingAddress: string;
    minimumAtomicAmount: string;
    maximumAtomicAmount: string;
    source: FlowRuntimeCapability['source'];
  }>,
): ReturnType<typeof flowRuntimeCapabilitySchema.safeParse> {
  return flowRuntimeCapabilitySchema.safeParse({
    ...input,
    mode: 'ERC20_DIRECT',
    chainId: resolveNetwork(input.environment).chainId,
    discoveredAt: new Date().toISOString(),
  });
}

/** Parses an integer env value (or `fallback`), returning `undefined` if it falls outside `[min, max]`. */
export function parseBoundedInt(
  raw: string | undefined,
  fallback: string,
  bounds: Readonly<{ min: number; max: number }>,
): number | undefined {
  const value = Number(raw ?? fallback);
  if (!Number.isSafeInteger(value) || value < bounds.min || value > bounds.max) return undefined;
  return value;
}
