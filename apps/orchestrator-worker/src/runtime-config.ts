import { GOAT_MAINNET, GOAT_TESTNET3 } from '@shipyard402/goat-network-config';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

import { EncryptedKeystoreKeySource, RawEnvKeySource, type SignerKeySource } from './signer-key-source.js';

const hexKeySchema = z.string().regex(/^0x[a-fA-F0-9]{64}$/);
const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const atomicAmountSchema = z.string().regex(/^(0|[1-9]\d*)$/);

const environmentSchema = z.object({
  APP_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().optional(),
  DATABASE_TLS: z.enum(['true', 'false']).optional(),
  GOAT_NETWORK_ENVIRONMENT: z.enum(['mainnet', 'testnet3']).default('testnet3'),
  GOAT_MAINNET_RPC_URL: z.string().url().optional(),
  GOAT_TESTNET_RPC_URL: z.string().url().optional(),
  ORCHESTRATOR_SIGNER_PRIVATE_KEY: hexKeySchema.optional(),
  ORCHESTRATOR_SIGNER_KEYSTORE_PATH: z.string().min(1).optional(),
  ORCHESTRATOR_SIGNER_KEYSTORE_PASSWORD: z.string().min(1).optional(),
  ORCHESTRATOR_TOOL_RECEIPT_SIGNER_PRIVATE_KEY: hexKeySchema.optional(),
  ORCHESTRATOR_TOOL_RECEIPT_SIGNER_KEYSTORE_PATH: z.string().min(1).optional(),
  ORCHESTRATOR_TOOL_RECEIPT_SIGNER_KEYSTORE_PASSWORD: z.string().min(1).optional(),
  ORCHESTRATOR_MAX_PROCUREMENT_SPEND_ATOMIC: atomicAmountSchema,
  SHIPYARD_RUN_REGISTRY_ADDRESS: addressSchema,
  SHIPYARD_AGENT_ID: z.string().min(1).max(256),
  ORCHESTRATOR_MANDATORY_SCENARIOS: z.string().min(1).default('payment-proof-replay'),
  DEMO_TARGET_BASE_URL: z.string().url(),
  DEMO_TARGET_HOST: z.string().min(1),
  DEMO_TARGET_TOOL_AGENT_ID: z.string().min(1).max(256),
  DEMO_TARGET_RECEIVING_ADDRESS: addressSchema,
  DEMO_TARGET_MINIMUM_ATOMIC_AMOUNT: atomicAmountSchema,
  DEMO_TARGET_MINIMUM_CONFIRMATIONS: z.string().regex(/^\d+$/).default('1'),
  DEMO_TARGET_TOOL_VERSION: z.string().min(1).default('x402-demo-target@0.1.0'),
  DEMO_TARGET_PROVIDER_SIGNER_ADDRESS: addressSchema.optional(),
  IPFS_API_URL: z.string().url(),
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_MODEL: z.string().min(1),
  ORCHESTRATOR_WORKER_ID: z.string().regex(/^[a-zA-Z0-9:_-]{1,200}$/).optional(),
  ORCHESTRATOR_POLL_INTERVAL_MS: z.string().regex(/^\d+$/).optional(),
  ORCHESTRATOR_LEASE_SECONDS: z.string().regex(/^\d+$/).optional(),
  ORCHESTRATOR_REFUNDS_ENABLED: z.enum(['true', 'false']).optional(),
}).strict();

const selectedNames = [
  'APP_ENV', 'DATABASE_URL', 'DATABASE_TLS', 'GOAT_NETWORK_ENVIRONMENT',
  'GOAT_MAINNET_RPC_URL', 'GOAT_TESTNET_RPC_URL',
  'ORCHESTRATOR_SIGNER_PRIVATE_KEY', 'ORCHESTRATOR_SIGNER_KEYSTORE_PATH', 'ORCHESTRATOR_SIGNER_KEYSTORE_PASSWORD',
  'ORCHESTRATOR_TOOL_RECEIPT_SIGNER_PRIVATE_KEY', 'ORCHESTRATOR_TOOL_RECEIPT_SIGNER_KEYSTORE_PATH',
  'ORCHESTRATOR_TOOL_RECEIPT_SIGNER_KEYSTORE_PASSWORD',
  'ORCHESTRATOR_MAX_PROCUREMENT_SPEND_ATOMIC', 'SHIPYARD_RUN_REGISTRY_ADDRESS', 'SHIPYARD_AGENT_ID',
  'ORCHESTRATOR_MANDATORY_SCENARIOS', 'DEMO_TARGET_BASE_URL', 'DEMO_TARGET_HOST',
  'DEMO_TARGET_TOOL_AGENT_ID', 'DEMO_TARGET_RECEIVING_ADDRESS', 'DEMO_TARGET_MINIMUM_ATOMIC_AMOUNT',
  'DEMO_TARGET_MINIMUM_CONFIRMATIONS', 'DEMO_TARGET_TOOL_VERSION', 'DEMO_TARGET_PROVIDER_SIGNER_ADDRESS', 'IPFS_API_URL',
  'OPENAI_API_KEY', 'OPENAI_MODEL', 'ORCHESTRATOR_WORKER_ID', 'ORCHESTRATOR_POLL_INTERVAL_MS',
  'ORCHESTRATOR_LEASE_SECONDS', 'ORCHESTRATOR_REFUNDS_ENABLED',
] as const;

export type OrchestratorWorkerRuntimeConfig = Readonly<{
  database: Readonly<{ connectionString: string; useTls: boolean }>;
  goatEnvironment: 'mainnet' | 'testnet3';
  rpcUrl: string;
  chainId: number;
  signerKeySource: SignerKeySource;
  toolReceiptSignerKeySource: SignerKeySource;
  maximumProcurementSpendAtomic: string;
  registryAddress: `0x${string}`;
  shipyardAgentId: string;
  mandatoryScenarios: readonly string[];
  demoTarget: Readonly<{
    baseUrl: string;
    host: string;
    toolAgentId: string;
    receivingAddress: `0x${string}`;
    minimumAtomicAmount: string;
    minimumConfirmations: number;
    toolVersion: string;
    providerSignerAddress?: `0x${string}`;
  }>;
  ipfsApiUrl: string;
  /**
   * Off by default: GOAT Flow merchant onboarding is still simulated, so the orchestrator signer
   * holds no real customer ERC20 balance to refund from yet. Flip this once it does.
   */
  refundsEnabled: boolean;
  openAi: Readonly<{ apiKey: string; model: string }>;
  workerId: string;
  pollIntervalMilliseconds: number;
  leaseDurationSeconds: number;
}>;

export class OrchestratorConfigurationError extends Error {
  readonly fields: readonly string[];

  constructor(message: string, fields: readonly string[]) {
    super(message);
    this.name = 'OrchestratorConfigurationError';
    this.fields = fields;
  }
}

export function parseOrchestratorWorkerRuntimeConfig(environment: NodeJS.ProcessEnv): OrchestratorWorkerRuntimeConfig {
  const selected = Object.fromEntries(selectedNames.map((name) => [name, environment[name]]));
  const parsed = environmentSchema.safeParse(selected);
  if (!parsed.success) {
    throw new OrchestratorConfigurationError(
      'Orchestrator worker configuration is incomplete or invalid',
      parsed.error.issues.map((issue) => issue.path.join('.')).filter(Boolean),
    );
  }
  const values = parsed.data;

  const connectionString = values.DATABASE_URL ?? (
    values.APP_ENV === 'production' ? undefined : 'postgresql://shipyard:shipyard@127.0.0.1:5432/shipyard'
  );
  if (!connectionString) {
    throw new OrchestratorConfigurationError('Production orchestrator worker requires PostgreSQL', ['DATABASE_URL']);
  }
  assertPostgresUrl(connectionString);

  const network = values.GOAT_NETWORK_ENVIRONMENT === 'mainnet' ? GOAT_MAINNET : GOAT_TESTNET3;
  const rpcField = values.GOAT_NETWORK_ENVIRONMENT === 'mainnet' ? 'GOAT_MAINNET_RPC_URL' : 'GOAT_TESTNET_RPC_URL';
  const rpcUrl = values.GOAT_NETWORK_ENVIRONMENT === 'mainnet'
    ? values.GOAT_MAINNET_RPC_URL ?? network.publicRpcUrl
    : values.GOAT_TESTNET_RPC_URL ?? network.publicRpcUrl;
  assertExactUrl(rpcUrl, network.publicRpcUrl, rpcField);

  const poll = Number(values.ORCHESTRATOR_POLL_INTERVAL_MS ?? '3000');
  if (!Number.isSafeInteger(poll) || poll < 250 || poll > 60_000) {
    throw new OrchestratorConfigurationError('Orchestrator poll interval must be between 250 and 60000 milliseconds', ['ORCHESTRATOR_POLL_INTERVAL_MS']);
  }
  const lease = Number(values.ORCHESTRATOR_LEASE_SECONDS ?? '120');
  if (!Number.isSafeInteger(lease) || lease < 5 || lease > 600) {
    throw new OrchestratorConfigurationError('Orchestrator lease must be between 5 and 600 seconds', ['ORCHESTRATOR_LEASE_SECONDS']);
  }

  const isProduction = values.APP_ENV === 'production';
  const signerKeySource = resolveSignerKeySource('ORCHESTRATOR_SIGNER', {
    rawKey: values.ORCHESTRATOR_SIGNER_PRIVATE_KEY,
    keystorePath: values.ORCHESTRATOR_SIGNER_KEYSTORE_PATH,
    keystorePassword: values.ORCHESTRATOR_SIGNER_KEYSTORE_PASSWORD,
  }, isProduction);
  const toolReceiptSignerKeySource = resolveSignerKeySource('ORCHESTRATOR_TOOL_RECEIPT_SIGNER', {
    rawKey: values.ORCHESTRATOR_TOOL_RECEIPT_SIGNER_PRIVATE_KEY,
    keystorePath: values.ORCHESTRATOR_TOOL_RECEIPT_SIGNER_KEYSTORE_PATH,
    keystorePassword: values.ORCHESTRATOR_TOOL_RECEIPT_SIGNER_KEYSTORE_PASSWORD,
  }, isProduction);

  return {
    database: {
      connectionString,
      useTls: values.DATABASE_TLS ? values.DATABASE_TLS === 'true' : values.APP_ENV === 'production',
    },
    goatEnvironment: values.GOAT_NETWORK_ENVIRONMENT,
    rpcUrl,
    chainId: network.chainId,
    signerKeySource,
    toolReceiptSignerKeySource,
    maximumProcurementSpendAtomic: values.ORCHESTRATOR_MAX_PROCUREMENT_SPEND_ATOMIC,
    registryAddress: values.SHIPYARD_RUN_REGISTRY_ADDRESS as `0x${string}`,
    shipyardAgentId: values.SHIPYARD_AGENT_ID,
    mandatoryScenarios: values.ORCHESTRATOR_MANDATORY_SCENARIOS.split(',').map((value) => value.trim()).filter(Boolean),
    demoTarget: {
      baseUrl: values.DEMO_TARGET_BASE_URL,
      host: values.DEMO_TARGET_HOST,
      toolAgentId: values.DEMO_TARGET_TOOL_AGENT_ID,
      receivingAddress: values.DEMO_TARGET_RECEIVING_ADDRESS as `0x${string}`,
      minimumAtomicAmount: values.DEMO_TARGET_MINIMUM_ATOMIC_AMOUNT,
      minimumConfirmations: Number(values.DEMO_TARGET_MINIMUM_CONFIRMATIONS),
      toolVersion: values.DEMO_TARGET_TOOL_VERSION,
      ...(values.DEMO_TARGET_PROVIDER_SIGNER_ADDRESS ? { providerSignerAddress: values.DEMO_TARGET_PROVIDER_SIGNER_ADDRESS as `0x${string}` } : {}),
    },
    ipfsApiUrl: values.IPFS_API_URL,
    refundsEnabled: values.ORCHESTRATOR_REFUNDS_ENABLED === 'true',
    openAi: { apiKey: values.OPENAI_API_KEY, model: values.OPENAI_MODEL },
    workerId: values.ORCHESTRATOR_WORKER_ID ?? `orchestrator-worker:${process.pid}`,
    pollIntervalMilliseconds: poll,
    leaseDurationSeconds: lease,
  };
}

function resolveSignerKeySource(
  fieldPrefix: string,
  input: Readonly<{ rawKey: string | undefined; keystorePath: string | undefined; keystorePassword: string | undefined }>,
  isProduction: boolean,
): SignerKeySource {
  const hasRaw = input.rawKey !== undefined;
  const hasKeystorePath = input.keystorePath !== undefined;
  const hasKeystorePassword = input.keystorePassword !== undefined;

  if (hasRaw && (hasKeystorePath || hasKeystorePassword)) {
    throw new OrchestratorConfigurationError(
      `${fieldPrefix}: configure either a raw private key or an encrypted keystore, not both`,
      [`${fieldPrefix}_PRIVATE_KEY`],
    );
  }

  if (hasKeystorePath || hasKeystorePassword) {
    if (!hasKeystorePath || !hasKeystorePassword) {
      throw new OrchestratorConfigurationError(
        `${fieldPrefix}: an encrypted keystore requires both a path and a password`,
        [`${fieldPrefix}_KEYSTORE_PATH`, `${fieldPrefix}_KEYSTORE_PASSWORD`],
      );
    }
    let keystoreJson: string;
    try {
      keystoreJson = readFileSync(input.keystorePath!, 'utf8');
    } catch {
      throw new OrchestratorConfigurationError(
        `${fieldPrefix}: could not read the keystore file at ${input.keystorePath}`,
        [`${fieldPrefix}_KEYSTORE_PATH`],
      );
    }
    return new EncryptedKeystoreKeySource(keystoreJson, input.keystorePassword!);
  }

  if (!hasRaw) {
    throw new OrchestratorConfigurationError(
      `${fieldPrefix}: either a raw private key or an encrypted keystore is required`,
      [`${fieldPrefix}_PRIVATE_KEY`],
    );
  }
  if (isProduction) {
    throw new OrchestratorConfigurationError(
      `${fieldPrefix}: production must use an encrypted keystore, not a raw private key in an environment variable`,
      [`${fieldPrefix}_PRIVATE_KEY`],
    );
  }
  return new RawEnvKeySource(input.rawKey as `0x${string}`);
}

function assertPostgresUrl(value: string): void {
  try {
    const parsed = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname || !parsed.pathname.slice(1)) {
      throw new Error('invalid');
    }
  } catch {
    throw new OrchestratorConfigurationError('DATABASE_URL must be a PostgreSQL URL', ['DATABASE_URL']);
  }
}

function assertExactUrl(value: string, expected: string, field: string): void {
  const parsed = new URL(value);
  if (
    parsed.origin !== expected || parsed.username || parsed.password ||
    !['', '/'].includes(parsed.pathname) || parsed.search || parsed.hash
  ) {
    throw new OrchestratorConfigurationError(`${field} must match the reviewed official origin`, [field]);
  }
}
