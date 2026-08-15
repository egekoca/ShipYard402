import { BOT_CHAIN_TESTNET, resolveBotChainRpcUrl } from '@shipyard402/bot-chain-network-config';
import {
  ConfigurationError,
  assertPostgresUrl,
  parseBoundedInt,
  resolveNetwork,
  resolveRpcUrl,
} from '@shipyard402/goat-network-config';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

import { EncryptedKeystoreKeySource, RawEnvKeySource, type SignerKeySource } from './signer-key-source.js';

const hexKeySchema = z.string().regex(/^0x[a-fA-F0-9]{64}$/);
const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const atomicAmountSchema = z.string().regex(/^(0|[1-9]\d*)$/);

const environmentSchema = z
  .object({
    APP_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DATABASE_URL: z.string().optional(),
    DATABASE_TLS: z.enum(['true', 'false']).optional(),
    GOAT_NETWORK_ENVIRONMENT: z.enum(['mainnet', 'testnet3']).default('testnet3'),
    GOAT_MAINNET_RPC_URL: z.string().url().optional(),
    GOAT_TESTNET_RPC_URL: z.string().url().optional(),
    // Which chain this process's procurement payments, registry attestations, and EIP-712 domain
    // target. Defaults to 'goat', reproducing today's exact behavior when unset -- GOAT_NETWORK_
    // ENVIRONMENT stays meaningful only in that default case. SHIPYARD_RUN_REGISTRY_ADDRESS is
    // reused as-is for whichever network is active, the same way it's a single value today.
    NETWORK: z.enum(['goat', 'bot-chain-testnet']).default('goat'),
    BOTCHAIN_TESTNET_RPC_URL: z.string().url().optional(),
    ORCHESTRATOR_SIGNER_PRIVATE_KEY: hexKeySchema.optional(),
    ORCHESTRATOR_SIGNER_KEYSTORE_PATH: z.string().min(1).optional(),
    ORCHESTRATOR_SIGNER_KEYSTORE_PASSWORD: z.string().min(1).optional(),
    ORCHESTRATOR_TOOL_RECEIPT_SIGNER_PRIVATE_KEY: hexKeySchema.optional(),
    ORCHESTRATOR_TOOL_RECEIPT_SIGNER_KEYSTORE_PATH: z.string().min(1).optional(),
    ORCHESTRATOR_TOOL_RECEIPT_SIGNER_KEYSTORE_PASSWORD: z.string().min(1).optional(),
    ORCHESTRATOR_MAX_PROCUREMENT_SPEND_ATOMIC: atomicAmountSchema,
    // Comma-separated. Required and non-empty on purpose: the target writes its own 402 challenge,
    // so an unset allowlist would mean signing an EIP-3009 authorization for whatever asset -- and
    // therefore whatever verifyingContract -- a customer-chosen endpoint asked for.
    ORCHESTRATOR_PROCUREMENT_ALLOWED_ASSETS: z.string().min(1),
    SHIPYARD_RUN_REGISTRY_ADDRESS: addressSchema,
    SHIPYARD_AGENT_ID: z.string().min(1).max(256),
    ORCHESTRATOR_MANDATORY_SCENARIOS: z.string().min(1).default('payment-proof-replay'),
    DEMO_TARGET_TOOL_AGENT_ID: z.string().min(1).max(256),
    DEMO_TARGET_TOOL_VERSION: z.string().min(1).default('x402-demo-target@0.1.0'),
    DEMO_TARGET_PROVIDER_SIGNER_ADDRESS: addressSchema.optional(),
    IPFS_API_URL: z.string().url(),
    OPENAI_API_KEY: z.string().min(1),
    OPENAI_MODEL: z.string().min(1),
    ORCHESTRATOR_WORKER_ID: z
      .string()
      .regex(/^[a-zA-Z0-9:_-]{1,200}$/)
      .optional(),
    ORCHESTRATOR_POLL_INTERVAL_MS: z.string().regex(/^\d+$/).optional(),
    ORCHESTRATOR_LEASE_SECONDS: z.string().regex(/^\d+$/).optional(),
    ORCHESTRATOR_REFUNDS_ENABLED: z.enum(['true', 'false']).optional(),
    // 'goat-bnb-*' bridges GOAT funds to BNB first; 'bnb-prefunded' pays from a BNB wallet that
    // already holds the settlement asset, which is the only way to reach a target priced in
    // something no Stargate route delivers.
    CROSS_CHAIN_PROCUREMENT_MODE: z
      .enum(['disabled', 'goat-bnb-usdt', 'goat-bnb-usdc', 'bnb-prefunded'])
      .default('disabled'),
    BNB_RPC_URL: z.string().url().optional(),
    BNB_X402_ENDPOINT: z.string().url().optional(),
    BNB_X402_PAY_TO: addressSchema.optional(),
    BNB_X402_PAYER_PRIVATE_KEY: hexKeySchema.optional(),
    /** Required by 'bnb-prefunded': the ERC-20 the destination payer already holds and will spend. */
    BNB_X402_SETTLEMENT_ASSET: addressSchema.optional(),
    /**
     * What this purchase costs the run's tool budget, in the funding rail's units. It cannot be
     * derived from the destination amount: the two rails use different assets and decimals, so
     * comparing them numerically is meaningless. Bridged runs default it to the amount that
     * actually leaves the funding rail; a prefunded run must state it, because nothing leaves.
     */
    CROSS_CHAIN_POLICY_COST_ATOMIC: z
      .string()
      .regex(/^[1-9]\d*$/)
      .optional(),
    CROSS_CHAIN_SOURCE_BRIDGE_AMOUNT_ATOMIC: z
      .string()
      .regex(/^[1-9]\d*$/)
      .optional(),
    BNB_X402_TARGET_AMOUNT_ATOMIC: z
      .string()
      .regex(/^[1-9]\d*$/)
      .optional(),
    STARGATE_MAX_NATIVE_FEE_WEI: z
      .string()
      .regex(/^[1-9]\d*$/)
      .optional(),
    STARGATE_MAX_BRIDGE_WAIT_SECONDS: z.string().regex(/^\d+$/).optional(),
    BNB_MAX_APPROVAL_GAS_COST_WEI: z
      .string()
      .regex(/^[1-9]\d*$/)
      .optional(),
    LAYERZERO_SCAN_API_URL: z.string().url().optional(),
  })
  .strict();

const selectedNames = [
  'APP_ENV',
  'DATABASE_URL',
  'DATABASE_TLS',
  'GOAT_NETWORK_ENVIRONMENT',
  'GOAT_MAINNET_RPC_URL',
  'GOAT_TESTNET_RPC_URL',
  'NETWORK',
  'BOTCHAIN_TESTNET_RPC_URL',
  'ORCHESTRATOR_SIGNER_PRIVATE_KEY',
  'ORCHESTRATOR_SIGNER_KEYSTORE_PATH',
  'ORCHESTRATOR_SIGNER_KEYSTORE_PASSWORD',
  'ORCHESTRATOR_TOOL_RECEIPT_SIGNER_PRIVATE_KEY',
  'ORCHESTRATOR_TOOL_RECEIPT_SIGNER_KEYSTORE_PATH',
  'ORCHESTRATOR_TOOL_RECEIPT_SIGNER_KEYSTORE_PASSWORD',
  'ORCHESTRATOR_MAX_PROCUREMENT_SPEND_ATOMIC',
  'ORCHESTRATOR_PROCUREMENT_ALLOWED_ASSETS',
  'SHIPYARD_RUN_REGISTRY_ADDRESS',
  'SHIPYARD_AGENT_ID',
  'ORCHESTRATOR_MANDATORY_SCENARIOS',
  'DEMO_TARGET_TOOL_AGENT_ID',
  'DEMO_TARGET_TOOL_VERSION',
  'DEMO_TARGET_PROVIDER_SIGNER_ADDRESS',
  'IPFS_API_URL',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'ORCHESTRATOR_WORKER_ID',
  'ORCHESTRATOR_POLL_INTERVAL_MS',
  'ORCHESTRATOR_LEASE_SECONDS',
  'ORCHESTRATOR_REFUNDS_ENABLED',
  'CROSS_CHAIN_PROCUREMENT_MODE',
  'BNB_RPC_URL',
  'BNB_X402_ENDPOINT',
  'BNB_X402_PAY_TO',
  'BNB_X402_PAYER_PRIVATE_KEY',
  'BNB_X402_SETTLEMENT_ASSET',
  'CROSS_CHAIN_POLICY_COST_ATOMIC',
  'CROSS_CHAIN_SOURCE_BRIDGE_AMOUNT_ATOMIC',
  'BNB_X402_TARGET_AMOUNT_ATOMIC',
  'STARGATE_MAX_NATIVE_FEE_WEI',
  'STARGATE_MAX_BRIDGE_WAIT_SECONDS',
  'BNB_MAX_APPROVAL_GAS_COST_WEI',
  'LAYERZERO_SCAN_API_URL',
] as const;

export type OrchestratorWorkerRuntimeConfig = Readonly<{
  database: Readonly<{ connectionString: string; useTls: boolean }>;
  network: 'goat' | 'bot-chain-testnet';
  goatEnvironment: 'mainnet' | 'testnet3';
  rpcUrl: string;
  chainId: number;
  signerKeySource: SignerKeySource;
  toolReceiptSignerKeySource: SignerKeySource;
  maximumProcurementSpendAtomic: string;
  procurementAllowedAssets: readonly `0x${string}`[];
  registryAddress: `0x${string}`;
  shipyardAgentId: string;
  mandatoryScenarios: readonly string[];
  demoTarget: Readonly<{
    toolAgentId: string;
    toolVersion: string;
    providerSignerAddress?: `0x${string}`;
  }>;
  ipfsApiUrl: string;
  /**
   * Off by default: GOAT Flow merchant onboarding is still simulated, so the orchestrator signer
   * holds no real customer ERC20 balance to refund from yet. Flip this once it does.
   */
  refundsEnabled: boolean;
  crossChain?: Readonly<{
    mode: 'BRIDGE_THEN_PAY' | 'PREFUNDED';
    /** What this purchase draws from the run's tool budget, in the funding rail's units. */
    policyCostAtomic: string;
    bnbRpcUrl: string;
    targetEndpoint: string;
    targetPayToAddress?: `0x${string}`;
    bnbPayerPrivateKey: `0x${string}`;
    /** Ceiling for one target payment. The price charged comes from the target's 402 challenge. */
    targetPaymentAmountAtomic: string;
    maxApprovalGasCostWei: string;
    /** Set only in PREFUNDED: the asset the payer already holds. Bridged modes derive it from the route. */
    settlementAsset?: `0x${string}`;
    /** Set only in BRIDGE_THEN_PAY. */
    bridge?: Readonly<{
      /** Which GOAT->BNB Stargate route to bridge over, chosen by the source asset. */
      sourceAssetSymbol: 'USDT' | 'USDC';
      sourceBridgeAmountAtomic: string;
      maxNativeFeeWei: string;
      maximumBridgeWaitSeconds: number;
      layerZeroScanApiUrl: string;
    }>;
  }>;
  openAi: Readonly<{ apiKey: string; model: string }>;
  workerId: string;
  pollIntervalMilliseconds: number;
  leaseDurationSeconds: number;
}>;

export class OrchestratorConfigurationError extends ConfigurationError {
  constructor(message: string, fields: readonly string[]) {
    super(message, fields);
    this.name = 'OrchestratorConfigurationError';
  }
}

/**
 * Splits and normalises the procurement asset allowlist. Rejects an all-blank list rather than
 * treating it as "no restriction": an empty allowlist here would silently restore the unbounded
 * signer this setting exists to prevent.
 */
function parseAllowedAssets(raw: string): readonly `0x${string}`[] {
  const assets = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (assets.length === 0) {
    throwOrchestratorConfigurationError('At least one procurement settlement asset must be allowed', [
      'ORCHESTRATOR_PROCUREMENT_ALLOWED_ASSETS',
    ]);
  }
  for (const asset of assets) {
    if (!/^0x[a-fA-F0-9]{40}$/.test(asset)) {
      throwOrchestratorConfigurationError(`Allowed procurement asset is not an address: ${asset}`, [
        'ORCHESTRATOR_PROCUREMENT_ALLOWED_ASSETS',
      ]);
    }
  }
  return assets as readonly `0x${string}`[];
}

function throwOrchestratorConfigurationError(message: string, fields: readonly string[]): never {
  throw new OrchestratorConfigurationError(message, fields);
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

  const connectionString =
    values.DATABASE_URL ??
    (values.APP_ENV === 'production' ? undefined : 'postgresql://shipyard:shipyard@127.0.0.1:5432/shipyard');
  if (!connectionString) {
    throw new OrchestratorConfigurationError('Production orchestrator worker requires PostgreSQL', ['DATABASE_URL']);
  }
  assertPostgresUrl(connectionString, throwOrchestratorConfigurationError);

  const rpcUrl =
    values.NETWORK === 'bot-chain-testnet'
      ? resolveBotChainRpcUrl(
          'botChainTestnet',
          { testnetRpcUrl: values.BOTCHAIN_TESTNET_RPC_URL },
          throwOrchestratorConfigurationError,
        )
      : resolveRpcUrl(
          values.GOAT_NETWORK_ENVIRONMENT,
          { mainnetRpcUrl: values.GOAT_MAINNET_RPC_URL, testnetRpcUrl: values.GOAT_TESTNET_RPC_URL },
          throwOrchestratorConfigurationError,
        );
  const chainId =
    values.NETWORK === 'bot-chain-testnet'
      ? BOT_CHAIN_TESTNET.chainId
      : resolveNetwork(values.GOAT_NETWORK_ENVIRONMENT).chainId;

  const poll = parseBoundedInt(values.ORCHESTRATOR_POLL_INTERVAL_MS, '3000', { min: 250, max: 60_000 });
  if (poll === undefined) {
    throw new OrchestratorConfigurationError('Orchestrator poll interval must be between 250 and 60000 milliseconds', [
      'ORCHESTRATOR_POLL_INTERVAL_MS',
    ]);
  }
  const lease = parseBoundedInt(values.ORCHESTRATOR_LEASE_SECONDS, '120', { min: 5, max: 600 });
  if (lease === undefined) {
    throw new OrchestratorConfigurationError('Orchestrator lease must be between 5 and 600 seconds', [
      'ORCHESTRATOR_LEASE_SECONDS',
    ]);
  }

  const isProduction = values.APP_ENV === 'production';
  const signerKeySource = resolveSignerKeySource(
    'ORCHESTRATOR_SIGNER',
    {
      rawKey: values.ORCHESTRATOR_SIGNER_PRIVATE_KEY,
      keystorePath: values.ORCHESTRATOR_SIGNER_KEYSTORE_PATH,
      keystorePassword: values.ORCHESTRATOR_SIGNER_KEYSTORE_PASSWORD,
    },
    isProduction,
  );
  const toolReceiptSignerKeySource = resolveSignerKeySource(
    'ORCHESTRATOR_TOOL_RECEIPT_SIGNER',
    {
      rawKey: values.ORCHESTRATOR_TOOL_RECEIPT_SIGNER_PRIVATE_KEY,
      keystorePath: values.ORCHESTRATOR_TOOL_RECEIPT_SIGNER_KEYSTORE_PATH,
      keystorePassword: values.ORCHESTRATOR_TOOL_RECEIPT_SIGNER_KEYSTORE_PASSWORD,
    },
    isProduction,
  );

  const crossChain = resolveCrossChainConfig(values, isProduction);

  return {
    database: {
      connectionString,
      useTls: values.DATABASE_TLS ? values.DATABASE_TLS === 'true' : values.APP_ENV === 'production',
    },
    network: values.NETWORK,
    goatEnvironment: values.GOAT_NETWORK_ENVIRONMENT,
    rpcUrl,
    chainId,
    signerKeySource,
    toolReceiptSignerKeySource,
    maximumProcurementSpendAtomic: values.ORCHESTRATOR_MAX_PROCUREMENT_SPEND_ATOMIC,
    procurementAllowedAssets: parseAllowedAssets(values.ORCHESTRATOR_PROCUREMENT_ALLOWED_ASSETS),
    registryAddress: values.SHIPYARD_RUN_REGISTRY_ADDRESS as `0x${string}`,
    shipyardAgentId: values.SHIPYARD_AGENT_ID,
    mandatoryScenarios: values.ORCHESTRATOR_MANDATORY_SCENARIOS.split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    demoTarget: {
      toolAgentId: values.DEMO_TARGET_TOOL_AGENT_ID,
      toolVersion: values.DEMO_TARGET_TOOL_VERSION,
      ...(values.DEMO_TARGET_PROVIDER_SIGNER_ADDRESS
        ? { providerSignerAddress: values.DEMO_TARGET_PROVIDER_SIGNER_ADDRESS as `0x${string}` }
        : {}),
    },
    ipfsApiUrl: values.IPFS_API_URL,
    refundsEnabled: values.ORCHESTRATOR_REFUNDS_ENABLED === 'true',
    ...(crossChain ? { crossChain } : {}),
    openAi: { apiKey: values.OPENAI_API_KEY, model: values.OPENAI_MODEL },
    workerId: values.ORCHESTRATOR_WORKER_ID ?? `orchestrator-worker:${process.pid}`,
    pollIntervalMilliseconds: poll,
    leaseDurationSeconds: lease,
  };
}

function resolveCrossChainConfig(
  values: z.infer<typeof environmentSchema>,
  isProduction: boolean,
): OrchestratorWorkerRuntimeConfig['crossChain'] {
  const mode = values.CROSS_CHAIN_PROCUREMENT_MODE;
  if (mode === 'disabled') return undefined;
  const prefunded = mode === 'bnb-prefunded';

  // Every mode needs a destination payer and a target; only a bridged one needs a source rail.
  const required: Record<string, string | undefined> = {
    BNB_RPC_URL: values.BNB_RPC_URL,
    BNB_X402_ENDPOINT: values.BNB_X402_ENDPOINT,
    BNB_X402_PAYER_PRIVATE_KEY: values.BNB_X402_PAYER_PRIVATE_KEY,
    BNB_X402_TARGET_AMOUNT_ATOMIC: values.BNB_X402_TARGET_AMOUNT_ATOMIC,
    BNB_MAX_APPROVAL_GAS_COST_WEI: values.BNB_MAX_APPROVAL_GAS_COST_WEI,
    ...(prefunded
      ? {
          BNB_X402_SETTLEMENT_ASSET: values.BNB_X402_SETTLEMENT_ASSET,
          CROSS_CHAIN_POLICY_COST_ATOMIC: values.CROSS_CHAIN_POLICY_COST_ATOMIC,
        }
      : {
          CROSS_CHAIN_SOURCE_BRIDGE_AMOUNT_ATOMIC: values.CROSS_CHAIN_SOURCE_BRIDGE_AMOUNT_ATOMIC,
          STARGATE_MAX_NATIVE_FEE_WEI: values.STARGATE_MAX_NATIVE_FEE_WEI,
        }),
  };
  const missing = Object.entries(required)
    .filter(([, value]) => value === undefined)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new OrchestratorConfigurationError(`${mode} procurement configuration is incomplete`, missing);
  }

  // Only a bridged run spends GOAT mainnet funds, so only it needs the source chain pinned there.
  // A prefunded run touches no GOAT balance at all and may run alongside any GOAT environment.
  if (!prefunded && (values.NETWORK !== 'goat' || values.GOAT_NETWORK_ENVIRONMENT !== 'mainnet')) {
    throw new OrchestratorConfigurationError('GOAT→BNB Stargate procurement requires GOAT mainnet', [
      'NETWORK',
      'GOAT_NETWORK_ENVIRONMENT',
    ]);
  }
  if (isProduction) {
    throw new OrchestratorConfigurationError(
      'Production cross-chain procurement requires encrypted destination-key support before activation',
      ['BNB_X402_PAYER_PRIVATE_KEY'],
    );
  }

  const shared = {
    // A bridged run's budget cost is what actually leaves the funding rail, unless the operator
    // overrides it; a prefunded run has no such amount, so the required env above supplies it.
    policyCostAtomic: (values.CROSS_CHAIN_POLICY_COST_ATOMIC ?? required['CROSS_CHAIN_SOURCE_BRIDGE_AMOUNT_ATOMIC'])!,
    bnbRpcUrl: required['BNB_RPC_URL']!,
    targetEndpoint: required['BNB_X402_ENDPOINT']!,
    bnbPayerPrivateKey: required['BNB_X402_PAYER_PRIVATE_KEY'] as `0x${string}`,
    targetPaymentAmountAtomic: required['BNB_X402_TARGET_AMOUNT_ATOMIC']!,
    maxApprovalGasCostWei: required['BNB_MAX_APPROVAL_GAS_COST_WEI']!,
    // Optional on purpose: set it to pin a known counterparty (our own controlled target), leave
    // it unset to pay whichever recipient a discovered service publishes -- still bounded by the
    // network, asset and amount ceilings in the payer's policy.
    ...(values.BNB_X402_PAY_TO ? { targetPayToAddress: values.BNB_X402_PAY_TO as `0x${string}` } : {}),
  } as const;

  if (prefunded) {
    return {
      ...shared,
      mode: 'PREFUNDED',
      settlementAsset: required['BNB_X402_SETTLEMENT_ASSET'] as `0x${string}`,
    };
  }

  const maximumBridgeWaitSeconds = parseBoundedInt(values.STARGATE_MAX_BRIDGE_WAIT_SECONDS, '1800', {
    min: 60,
    max: 86_400,
  });
  if (maximumBridgeWaitSeconds === undefined) {
    throw new OrchestratorConfigurationError('Stargate bridge wait must be between 60 and 86400 seconds', [
      'STARGATE_MAX_BRIDGE_WAIT_SECONDS',
    ]);
  }
  return {
    ...shared,
    mode: 'BRIDGE_THEN_PAY',
    bridge: {
      sourceAssetSymbol: mode === 'goat-bnb-usdc' ? 'USDC' : 'USDT',
      sourceBridgeAmountAtomic: required['CROSS_CHAIN_SOURCE_BRIDGE_AMOUNT_ATOMIC']!,
      maxNativeFeeWei: required['STARGATE_MAX_NATIVE_FEE_WEI']!,
      maximumBridgeWaitSeconds,
      layerZeroScanApiUrl: values.LAYERZERO_SCAN_API_URL ?? 'https://scan.layerzero-api.com/v1/',
    },
  };
}

function resolveSignerKeySource(
  fieldPrefix: string,
  input: Readonly<{
    rawKey: string | undefined;
    keystorePath: string | undefined;
    keystorePassword: string | undefined;
  }>,
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
