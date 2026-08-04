import { GoatFlowMerchantAdapter, type ReviewedCapabilitySource } from '@shipyard402/goat-flow-adapter';
import type { FlowRuntimeCapability } from '@shipyard402/goat-network-config';
import {
  createShipyardPool,
  assertShipyardSchemaReady,
  PostgresFlowOrderContextStore,
  PostgresQuoteRepository,
  PostgresRunRepository,
} from '@shipyard402/persistence-postgres';
import { QuoteEngine } from '@shipyard402/quote-engine';

import {
  createApp,
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

class UnavailableCapabilityProvider implements RuntimeCapabilityProvider {
  async getShipyardMerchantCapability(): Promise<null> {
    return null;
  }
}

class PostgresRuntimeStatusProvider implements RuntimeStatusProvider {
  readonly #pool: ReturnType<typeof createShipyardPool>;
  readonly #environment: 'development' | 'test' | 'production';
  readonly #merchantConfigured: boolean;

  constructor(
    pool: ReturnType<typeof createShipyardPool>,
    environment: 'development' | 'test' | 'production',
    merchantConfigured: boolean,
  ) {
    this.#pool = pool;
    this.#environment = environment;
    this.#merchantConfigured = merchantConfigured;
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
      };
    } catch {
      return {
        status: 'unavailable' as const,
        environment: this.#environment,
        persistence: 'postgresql' as const,
        database: 'unavailable' as const,
        merchantPayments: this.#merchantConfigured ? 'configured' as const : 'not_configured' as const,
      };
    }
  }
}

async function start(): Promise<void> {
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
    ? GoatFlowMerchantAdapter.fromMainnetCredentials({
        merchantId: merchantConfig.merchantId,
        apiKey: merchantConfig.apiKey,
        apiSecret: merchantConfig.apiSecret,
        contextStore: new PostgresFlowOrderContextStore(pool),
        capabilitySource: new StaticReviewedCapabilitySource(merchantConfig.capability),
      })
    : undefined;

  const capabilityProvider = merchantAdapter && merchantConfig
    ? new VerifiedMerchantCapabilityProvider(merchantAdapter, merchantConfig.capability)
    : new UnavailableCapabilityProvider();

  const app = createApp({
    allowedWebOrigins: config.allowedWebOrigins,
    capabilityProvider,
    quoteEngine: new QuoteEngine({
      pricingStatus: 'HYPOTHESIS',
      baseOrchestrationFeeAtomic: '2000000',
      mandatoryToolBudgetAtomic: '1200000',
      dynamicToolBudgetAtomic: '600000',
      modelInfrastructureReserveAtomic: '350000',
      chainStorageReserveAtomic: '150000',
      riskSupportReserveAtomic: '400000',
      quoteTtlSeconds: 900,
    }),
    quoteRepository,
    runRepository,
    runtimeStatusProvider: new PostgresRuntimeStatusProvider(
      pool,
      config.environment,
      merchantAdapter !== undefined,
    ),
    ...(merchantAdapter ? { merchantAdapter } : {}),
  });

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

await start();
