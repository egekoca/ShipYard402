import { BotChainDirectMerchantAdapter, type BotChainReceiptSource } from '@shipyard402/bot-chain-adapter';
import type { BotChainRuntimeCapability } from '@shipyard402/bot-chain-network-config';
import { GoatFlowMerchantAdapter, type ReviewedCapabilitySource } from '@shipyard402/goat-flow-adapter';
import type { FlowRuntimeCapability } from '@shipyard402/goat-network-config';
import {
  createShipyardPool,
  assertShipyardSchemaReady,
  listMarketplaceServices,
  onboardService,
  PostgresAttestationStore,
  PostgresBotChainOrderContextStore,
  PostgresEvidencePackStore,
  PostgresFlowOrderContextStore,
  PostgresOrchestratorCheckpointStore,
  PostgresPaymentReconciliationJobQueue,
  PostgresRunSettlementLegStore,
  PostgresQuoteRepository,
  PostgresRunRepository,
  PostgresStepDurationStatsStore,
  type OrchestratorCheckpointStore,
} from '@shipyard402/persistence-postgres';
import { QuoteEngine } from '@shipyard402/quote-engine';
import type { MerchantCapability } from '@shipyard402/x402-payments';

import {
  createApp,
  type CatalogListingProvider,
  type MarketplaceService,
  type OnboardedService,
  type PaymentTransactionSubmitter,
  type PlanProvider,
  type ProcurementProgressProvider,
  type PublicPlan,
  type PublicSettlementLeg,
  type RuntimeCapabilityProvider,
  type RuntimeStatusProvider,
  type ServiceOnboardingInput,
  type ServiceOnboardingProvider,
} from './app.js';
import { parseRuntimeConfig } from './runtime-config.js';

// api-gateway only ever calls createOrder()/submitPaymentTransaction() on a BOT Chain adapter --
// verifying a payment (getOrderStatus/getOrderProof, which need a real chain reader) is
// payment-worker's job, not api-gateway's. This stub keeps that boundary explicit instead of
// pulling a real RPC client into a process that never needs one.
class UnusedBotChainReceiptSource implements BotChainReceiptSource {
  async getTransactionReceipt(): Promise<never> {
    throw new Error('api-gateway does not verify BOT Chain payments directly; payment-worker does');
  }
}

class BotChainPaymentTransactionSubmitter implements PaymentTransactionSubmitter {
  readonly #adapter: BotChainDirectMerchantAdapter;
  readonly #queue: PostgresPaymentReconciliationJobQueue;

  constructor(adapter: BotChainDirectMerchantAdapter, queue: PostgresPaymentReconciliationJobQueue) {
    this.#adapter = adapter;
    this.#queue = queue;
  }

  async submitPaymentTransaction(runId: string, orderId: string, transactionHash: `0x${string}`): Promise<void> {
    await this.#adapter.submitPaymentTransaction(orderId, transactionHash);
    await this.#queue.rearm(runId);
  }
}

class StaticBotChainCapabilityProvider implements RuntimeCapabilityProvider {
  readonly #capability: BotChainRuntimeCapability;

  constructor(capability: BotChainRuntimeCapability) {
    this.#capability = capability;
  }

  async getShipyardMerchantCapability(): Promise<MerchantCapability | null> {
    return this.#capability;
  }
}

class StaticReviewedCapabilitySource implements ReviewedCapabilitySource {
  readonly #capability: FlowRuntimeCapability;

  constructor(capability: FlowRuntimeCapability) {
    this.#capability = capability;
  }

  async loadReviewedCapabilities(): Promise<readonly FlowRuntimeCapability[]> {
    return [this.#capability];
  }
}

class VerifiedMerchantCapabilityProvider implements RuntimeCapabilityProvider {
  readonly #adapter: GoatFlowMerchantAdapter;
  readonly #reviewedCapability: FlowRuntimeCapability;

  constructor(adapter: GoatFlowMerchantAdapter, reviewedCapability: FlowRuntimeCapability) {
    this.#adapter = adapter;
    this.#reviewedCapability = reviewedCapability;
  }

  async getShipyardMerchantCapability(): Promise<FlowRuntimeCapability | null> {
    const capabilities = await this.#adapter.discoverRuntimeCapabilities();
    const exactMatches = capabilities.filter(
      (capability) =>
        capability.merchantId === this.#reviewedCapability.merchantId &&
        capability.chainId === this.#reviewedCapability.chainId &&
        sameAddress(capability.tokenAddress, this.#reviewedCapability.tokenAddress) &&
        sameAddress(capability.receivingAddress, this.#reviewedCapability.receivingAddress),
    );
    return exactMatches.length === 1 ? exactMatches[0]! : null;
  }
}

class CheckpointPlanProvider implements PlanProvider {
  readonly #store: OrchestratorCheckpointStore;

  constructor(store: OrchestratorCheckpointStore) {
    this.#store = store;
  }

  async getByRunId(runId: string): Promise<PublicPlan | null> {
    const checkpoint = await this.#store.load(runId);
    if (!checkpoint.plan) return null;
    return {
      runId,
      riskLevel: checkpoint.plan.riskLevel,
      scenarios: checkpoint.plan.scenarios,
      toolBudgetAtomic: checkpoint.plan.toolBudgetAtomic,
      rationale: checkpoint.plan.rationale,
      ...(checkpoint.proposal !== undefined ? { aiProposal: checkpoint.proposal } : {}),
    };
  }
}

class PostgresSettlementLegProvider implements ProcurementProgressProvider {
  readonly #store: PostgresRunSettlementLegStore;

  constructor(pool: ReturnType<typeof createShipyardPool>) {
    this.#store = new PostgresRunSettlementLegStore(pool);
  }

  async getByRunId(runId: string): Promise<readonly PublicSettlementLeg[]> {
    const legs = await this.#store.listByRunId(runId);
    // The asset's contract address is deliberately dropped here: the dashboard identifies assets by
    // symbol and never needs to hold a token address, and a public DTO should carry no more than
    // what its reader uses.
    return legs.map((leg) => ({
      legIndex: leg.legIndex,
      kind: leg.kind,
      network: leg.network,
      assetSymbol: leg.assetSymbol,
      assetDecimals: leg.assetDecimals,
      status: leg.status,
      ...(leg.transactionHash ? { transactionHash: leg.transactionHash } : {}),
      ...(leg.amountAtomic ? { amountAtomic: leg.amountAtomic } : {}),
      ...(leg.provider ? { provider: leg.provider } : {}),
      ...(leg.detail ? { detail: leg.detail } : {}),
    }));
  }
}

class PostgresServiceOnboardingProvider implements ServiceOnboardingProvider {
  readonly #pool: ReturnType<typeof createShipyardPool>;

  constructor(pool: ReturnType<typeof createShipyardPool>) {
    this.#pool = pool;
  }

  async onboard(input: ServiceOnboardingInput): Promise<OnboardedService> {
    return onboardService(this.#pool, input);
  }
}

class PostgresCatalogListingProvider implements CatalogListingProvider {
  readonly #pool: ReturnType<typeof createShipyardPool>;

  constructor(pool: ReturnType<typeof createShipyardPool>) {
    this.#pool = pool;
  }

  async listMarketplaceServices(): Promise<readonly MarketplaceService[]> {
    return listMarketplaceServices(this.#pool);
  }
}

class UnavailableCapabilityProvider implements RuntimeCapabilityProvider {
  async getShipyardMerchantCapability(): Promise<null> {
    return null;
  }
}

class PostgresRuntimeStatusProvider implements RuntimeStatusProvider {
  readonly #pool: ReturnType<typeof createShipyardPool>;
  readonly #environment: 'development' | 'test' | 'production';
  readonly #merchantConfigured: boolean;
  readonly #mainnetWritesEnabled: boolean;

  constructor(
    pool: ReturnType<typeof createShipyardPool>,
    environment: 'development' | 'test' | 'production',
    merchantConfigured: boolean,
    mainnetWritesEnabled: boolean,
  ) {
    this.#pool = pool;
    this.#environment = environment;
    this.#merchantConfigured = merchantConfigured;
    this.#mainnetWritesEnabled = mainnetWritesEnabled;
  }

  async getRuntimeStatus() {
    try {
      await this.#pool.query('SELECT 1');
      return {
        status: this.#merchantConfigured ? ('ok' as const) : ('degraded' as const),
        environment: this.#environment,
        persistence: 'postgresql' as const,
        database: 'connected' as const,
        merchantPayments: this.#merchantConfigured ? ('configured' as const) : ('not_configured' as const),
        mainnetWritesEnabled: this.#mainnetWritesEnabled,
      };
    } catch {
      return {
        status: 'unavailable' as const,
        environment: this.#environment,
        persistence: 'postgresql' as const,
        database: 'unavailable' as const,
        merchantPayments: this.#merchantConfigured ? ('configured' as const) : ('not_configured' as const),
        mainnetWritesEnabled: this.#mainnetWritesEnabled,
      };
    }
  }
}

export type BuiltApp = Readonly<{
  app: ReturnType<typeof createApp>;
  pool: ReturnType<typeof createShipyardPool>;
  config: ReturnType<typeof parseRuntimeConfig>;
}>;

/**
 * Everything short of actually binding a port -- shared by the long-running local/production
 * process (start(), below) and the Vercel serverless entrypoint (api/index.ts), which must never
 * call app.listen() itself since Vercel owns the request/response lifecycle.
 */
export async function buildApp(): Promise<BuiltApp> {
  const config = parseRuntimeConfig(process.env);
  const pool = createShipyardPool({
    connectionString: config.database.connectionString,
    useTls: config.database.useTls,
  });

  try {
    await pool.query('SELECT 1');
    await assertShipyardSchemaReady(pool);
  } catch (error) {
    await pool.end();
    throw new Error('PostgreSQL readiness check failed; API startup was aborted', { cause: error });
  }

  const quoteRepository = new PostgresQuoteRepository(pool);
  const runRepository = new PostgresRunRepository(pool);
  const checkpointStore = new PostgresOrchestratorCheckpointStore(pool);

  // Exactly one of these two branches is active per process, selected by MERCHANT_ADAPTER -- the
  // other's config is simply absent (parseRuntimeConfig only fills in the one that matches). GOAT
  // Flow's construction, credentials, and Postgres-backed order context store are completely
  // unchanged from before BOT Chain support existed.
  const merchantConfig = config.merchant;
  const goatMerchantAdapter = merchantConfig
    ? config.goatEnvironment === 'mainnet'
      ? GoatFlowMerchantAdapter.fromMainnetCredentials({
          merchantId: merchantConfig.merchantId,
          apiKey: merchantConfig.apiKey,
          apiSecret: merchantConfig.apiSecret,
          contextStore: new PostgresFlowOrderContextStore(pool),
          capabilitySource: new StaticReviewedCapabilitySource(merchantConfig.capability),
        })
      : GoatFlowMerchantAdapter.fromTestnet3Credentials({
          merchantId: merchantConfig.merchantId,
          apiKey: merchantConfig.apiKey,
          apiSecret: merchantConfig.apiSecret,
          contextStore: new PostgresFlowOrderContextStore(pool),
          capabilitySource: new StaticReviewedCapabilitySource(merchantConfig.capability),
        })
    : undefined;

  const botChainMerchantConfig = config.botChainMerchant;
  const botChainMerchantAdapter = botChainMerchantConfig
    ? new BotChainDirectMerchantAdapter({
        capability: botChainMerchantConfig.capability,
        contextStore: new PostgresBotChainOrderContextStore(pool),
        receiptSource: new UnusedBotChainReceiptSource(),
      })
    : undefined;

  const merchantAdapter = config.merchantAdapter === 'bot-chain-direct' ? botChainMerchantAdapter : goatMerchantAdapter;

  const capabilityProvider =
    config.merchantAdapter === 'bot-chain-direct'
      ? botChainMerchantAdapter && botChainMerchantConfig
        ? new StaticBotChainCapabilityProvider(botChainMerchantConfig.capability)
        : new UnavailableCapabilityProvider()
      : goatMerchantAdapter && merchantConfig
        ? new VerifiedMerchantCapabilityProvider(goatMerchantAdapter, merchantConfig.capability)
        : new UnavailableCapabilityProvider();

  const paymentTransactionSubmitter: PaymentTransactionSubmitter | undefined = botChainMerchantAdapter
    ? new BotChainPaymentTransactionSubmitter(botChainMerchantAdapter, new PostgresPaymentReconciliationJobQueue(pool))
    : undefined;

  const app = createApp({
    allowedWebOrigins: config.allowedWebOrigins,
    capabilityProvider,
    quoteEngine: new QuoteEngine({
      pricingStatus: 'HYPOTHESIS',
      // Shipyard's revenue is a 5% take rate on the run's actual pass-through costs below, not a
      // flat fee -- those costs are themselves kept minimal (AI call, chain gas, contingency).
      feeRateBps: 500,
      mandatoryToolBudgetAtomic: '800000',
      dynamicToolBudgetAtomic: '300000',
      modelInfrastructureReserveAtomic: '100000',
      chainStorageReserveAtomic: '50000',
      riskSupportReserveAtomic: '100000',
      quoteTtlSeconds: 900,
    }),
    quoteRepository,
    runRepository,
    evidencePackProvider: new PostgresEvidencePackStore(pool),
    attestationProvider: new PostgresAttestationStore(pool),
    planProvider: new CheckpointPlanProvider(checkpointStore),
    procurementProgressProvider: new PostgresSettlementLegProvider(pool),
    stepDurationStatsProvider: new PostgresStepDurationStatsStore(pool),
    serviceOnboardingProvider: new PostgresServiceOnboardingProvider(pool),
    catalogListingProvider: new PostgresCatalogListingProvider(pool),
    runtimeStatusProvider: new PostgresRuntimeStatusProvider(
      pool,
      config.environment,
      merchantAdapter !== undefined,
      config.merchantAdapter === 'goat-flow' &&
        goatMerchantAdapter !== undefined &&
        config.goatEnvironment === 'mainnet',
    ),
    ...(merchantAdapter ? { merchantAdapter } : {}),
    ...(paymentTransactionSubmitter ? { paymentTransactionSubmitter } : {}),
    ...(config.sessionSigningSecret ? { sessionSecret: config.sessionSigningSecret } : {}),
  });

  return { app, pool, config };
}

async function start(): Promise<void> {
  const { app, pool, config } = await buildApp();

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    await pool.end();
    throw error;
  }
  process.stdout.write(`Shipyard402 API listening on ${config.host}:${config.port} with PostgreSQL persistence\n`);

  let shuttingDown = false;
  async function shutdown(signal: NodeJS.Signals): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`Received ${signal}; stopping Shipyard402 API\n`);
    try {
      await app.close();
    } finally {
      await pool.end();
    }
  }

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

// Only bind a port when this file is run directly (`node server.js` / `tsx src/server.ts`) --
// not when it's imported purely for buildApp(), as the Vercel serverless entrypoint does. Vercel
// owns the request/response lifecycle itself and must never see this process try to listen.
const isDirectlyExecuted = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isDirectlyExecuted) await start();
