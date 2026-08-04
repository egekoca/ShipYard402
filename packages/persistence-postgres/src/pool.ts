import { Pool, type PoolConfig } from 'pg';

export const SHIPYARD_REQUIRED_SCHEMA_VERSION = '0003_orchestrator_jobs.sql';

export type ShipyardPoolOptions = Readonly<{
  connectionString: string;
  maximumConnections?: number;
  useTls?: boolean;
}>;

export function createShipyardPool(options: ShipyardPoolOptions): Pool {
  if (!options.connectionString) throw new Error('PostgreSQL connection string is required');
  const config: PoolConfig = {
    connectionString: options.connectionString,
    max: options.maximumConnections ?? 10,
    application_name: 'shipyard402-backend',
    statement_timeout: 15_000,
    query_timeout: 20_000,
    ssl: options.useTls ? { rejectUnauthorized: true } : false,
  };
  return new Pool(config);
}

export async function assertShipyardSchemaReady(pool: Pool): Promise<void> {
  const objects = await pool.query<{
    has_runs: boolean;
    has_payment_receipts: boolean;
    has_payment_jobs: boolean;
    has_orchestrator_jobs: boolean;
    has_migration_ledger: boolean;
  }>(`
    SELECT
      to_regclass('public.runs') IS NOT NULL AS has_runs,
      to_regclass('public.payment_receipts') IS NOT NULL AS has_payment_receipts,
      to_regclass('public.payment_reconciliation_jobs') IS NOT NULL AS has_payment_jobs,
      to_regclass('public.orchestrator_jobs') IS NOT NULL AS has_orchestrator_jobs,
      to_regclass('public.shipyard_schema_migrations') IS NOT NULL AS has_migration_ledger
  `);
  const state = objects.rows[0];
  if (
    !state?.has_runs || !state.has_payment_receipts || !state.has_payment_jobs ||
    !state.has_orchestrator_jobs || !state.has_migration_ledger
  ) {
    throw new Error('PostgreSQL schema is incomplete; run the checksum-verified migrations before startup');
  }
  const version = await pool.query(
    `SELECT 1 FROM shipyard_schema_migrations WHERE version = $1`,
    [SHIPYARD_REQUIRED_SCHEMA_VERSION],
  );
  if (version.rowCount !== 1) {
    throw new Error(`PostgreSQL schema version is behind ${SHIPYARD_REQUIRED_SCHEMA_VERSION}`);
  }
}
