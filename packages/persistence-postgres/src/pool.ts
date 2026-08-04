import { Pool, type PoolConfig } from 'pg';

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
