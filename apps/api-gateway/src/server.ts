import { GoatFlowMerchantAdapter, type ReviewedCapabilitySource } from '@shipyard402/goat-flow-adapter';
import type { FlowRuntimeCapability } from '@shipyard402/goat-network-config';
import {
  createShipyardPool,
  assertShipyardSchemaReady,
  PostgresAttestationStore,
  PostgresEvidencePackStore,
  PostgresFlowOrderContextStore,
  PostgresOrchestratorCheckpointStore,
  PostgresQuoteRepository,
  PostgresRunRepository,
  PostgresStepDurationStatsStore,
  type OrchestratorCheckpointStore,
} from '@shipyard402/persistence-postgres';
import { QuoteEngine } from '@shipyard402/quote-engine';

import {
  createApp,
  type PlanProvider,
  type PublicPlan,
  type RuntimeCapabilityProvider,
  type RuntimeStatusProvider,
} from './app.js';
import { parseRuntimeConfig } from './runtime-config.js';

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
        status: this.#merchantConfigured ? 'ok' as const : 'degraded' as const,
        environment: this.#environment,
        persistence: 'postgresql' as const,
        database: 'connected' as const,
        merchantPayments: this.#merchantConfigured ? 'configured' as const : 'not_configured' as const,
        mainnetWritesEnabled: this.#mainnetWritesEnabled,
      };
    } catch {
      return {
        status: 'unavailable' as const,
        environment: this.#environment,
        persistence: 'postgresql' as const,
        database: 'unavailable' as const,
        merchantPayments: this.#merchantConfigured ? 'configured' as const : 'not_configured' as const,
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
  const merchantConfig = config.merchant;
  const merchantAdapter = merchantConfig
    ? (config.goatEnvironment === 'mainnet'
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
      }))
    : undefined;

  const capabilityProvider = merchantAdapter && merchantConfig
    ? new VerifiedMerchantCapabilityProvider(merchantAdapter, merchantConfig.capability)
    : new UnavailableCapabilityProvider();

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
    planProvider: new CheckpointPlanProvider(new PostgresOrchestratorCheckpointStore(pool)),
    stepDurationStatsProvider: new PostgresStepDurationStatsStore(pool),
    runtimeStatusProvider: new PostgresRuntimeStatusProvider(
      pool,
      config.environment,
      merchantAdapter !== undefined,
      merchantAdapter !== undefined && config.goatEnvironment === 'mainnet',
    ),
    ...(merchantAdapter ? { merchantAdapter } : {}),
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
const isDirectlyExecuted = process.argv[1] !== undefined
  && import.meta.url === `file://${process.argv[1]}`;
if (isDirectlyExecuted) await start();
