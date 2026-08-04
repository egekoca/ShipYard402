import { GOAT_MAINNET, GOAT_TESTNET3 } from '@shipyard402/goat-network-config';
import { z } from 'zod';

const environmentSchema = z.object({
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.string().regex(/^\d+$/).default('3002'),
  DEMO_MODE: z.enum(['V1_VULNERABLE', 'V2_PROTECTED']),
  DEMO_RECEIPT_SECRET: z.string().min(32),
  GOAT_NETWORK_ENVIRONMENT: z.enum(['mainnet', 'testnet3']).default('testnet3'),
  GOAT_MAINNET_RPC_URL: z.string().url().optional(),
  GOAT_TESTNET_RPC_URL: z.string().url().optional(),
  DEMO_TARGET_RECEIVING_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
  DEMO_TARGET_MINIMUM_ATOMIC_AMOUNT: z.string().regex(/^(0|[1-9]\d*)$/).optional(),
  DEMO_TARGET_MINIMUM_CONFIRMATIONS: z.string().regex(/^\d+$/).default('1'),
}).strict();

const selectedNames = [
  'HOST', 'PORT', 'DEMO_MODE', 'DEMO_RECEIPT_SECRET', 'GOAT_NETWORK_ENVIRONMENT',
  'GOAT_MAINNET_RPC_URL', 'GOAT_TESTNET_RPC_URL', 'DEMO_TARGET_RECEIVING_ADDRESS',
  'DEMO_TARGET_MINIMUM_ATOMIC_AMOUNT', 'DEMO_TARGET_MINIMUM_CONFIRMATIONS',
] as const;

export type DemoTargetRuntimeConfig = Readonly<{
  host: string;
  port: number;
  mode: 'V1_VULNERABLE' | 'V2_PROTECTED';
  receiptSecret: string;
  purchase?: Readonly<{
    goatEnvironment: 'mainnet' | 'testnet3';
    rpcUrl: string;
    receivingAddress: `0x${string}`;
    minimumAtomicAmount: string;
    minimumConfirmations: number;
  }>;
}>;

export class DemoTargetConfigurationError extends Error {
  readonly fields: readonly string[];

  constructor(message: string, fields: readonly string[]) {
    super(message);
    this.name = 'DemoTargetConfigurationError';
    this.fields = fields;
  }
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

  const base: DemoTargetRuntimeConfig = {
    host: values.HOST,
    port: Number(values.PORT),
    mode: values.DEMO_MODE,
    receiptSecret: values.DEMO_RECEIPT_SECRET,
  };

  if (!values.DEMO_TARGET_RECEIVING_ADDRESS) return base;
  if (!values.DEMO_TARGET_MINIMUM_ATOMIC_AMOUNT) {
    throw new DemoTargetConfigurationError(
      'DEMO_TARGET_MINIMUM_ATOMIC_AMOUNT is required once DEMO_TARGET_RECEIVING_ADDRESS is set',
      ['DEMO_TARGET_MINIMUM_ATOMIC_AMOUNT'],
    );
  }

  const network = values.GOAT_NETWORK_ENVIRONMENT === 'mainnet' ? GOAT_MAINNET : GOAT_TESTNET3;
  const rpcField = values.GOAT_NETWORK_ENVIRONMENT === 'mainnet' ? 'GOAT_MAINNET_RPC_URL' : 'GOAT_TESTNET_RPC_URL';
  const rpcUrl = values.GOAT_NETWORK_ENVIRONMENT === 'mainnet'
    ? values.GOAT_MAINNET_RPC_URL ?? network.publicRpcUrl
    : values.GOAT_TESTNET_RPC_URL ?? network.publicRpcUrl;
  assertExactUrl(rpcUrl, network.publicRpcUrl, rpcField);

  return {
    ...base,
    purchase: {
      goatEnvironment: values.GOAT_NETWORK_ENVIRONMENT,
      rpcUrl,
      receivingAddress: values.DEMO_TARGET_RECEIVING_ADDRESS as `0x${string}`,
      minimumAtomicAmount: values.DEMO_TARGET_MINIMUM_ATOMIC_AMOUNT,
      minimumConfirmations: Number(values.DEMO_TARGET_MINIMUM_CONFIRMATIONS),
    },
  };
}

function assertExactUrl(value: string, expected: string, field: string): void {
  const parsed = new URL(value);
  if (
    parsed.origin !== expected || parsed.username || parsed.password ||
    !['', '/'].includes(parsed.pathname) || parsed.search || parsed.hash
  ) {
    throw new DemoTargetConfigurationError(`${field} must match the reviewed official origin`, [field]);
  }
}
