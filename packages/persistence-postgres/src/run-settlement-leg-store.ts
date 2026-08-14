import type { Pool, QueryResultRow } from 'pg';

/**
 * One step of a run's money movement, on one chain, in one asset.
 *
 * Legs are how the dashboard learns what a run is actually doing without being told which shape of
 * procurement produced it: a bridged run writes a BRIDGE leg then a TARGET_PAYMENT leg, a prefunded
 * run writes only the payment, and a future swap step is simply another row.
 */
export type RunSettlementLeg = Readonly<{
  runId: string;
  /** Execution and display order within the run, 0-based. */
  legIndex: number;
  kind: 'BRIDGE' | 'TARGET_PAYMENT';
  /** CAIP-2 network id, e.g. `eip155:56`. */
  network: string;
  assetSymbol: string;
  assetDecimals: number;
  assetAddress?: `0x${string}`;
  status: 'PENDING' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED';
  transactionHash?: `0x${string}`;
  amountAtomic?: string;
  provider?: string;
  detail?: Readonly<Record<string, unknown>>;
}>;

type LegRow = QueryResultRow & {
  run_id: string;
  leg_index: number;
  kind: 'BRIDGE' | 'TARGET_PAYMENT';
  network: string;
  asset_symbol: string;
  asset_decimals: number;
  asset_address: Buffer | null;
  status: RunSettlementLeg['status'];
  transaction_hash: Buffer | null;
  amount_atomic: string | null;
  provider: string | null;
  detail: Record<string, unknown> | null;
};

export interface RunSettlementLegStore {
  /**
   * Writes a leg, or advances the one already at this index. Idempotent by (runId, legIndex) so a
   * re-claimed job that repeats a phase updates its leg rather than duplicating it, and never
   * regresses a leg that has already reached a later state.
   */
  record(leg: RunSettlementLeg): Promise<void>;
  listByRunId(runId: string): Promise<readonly RunSettlementLeg[]>;
}

/** Ordering used to reject a backwards status update; a FAILED leg may always be recorded. */
const STATUS_RANK: Readonly<Record<RunSettlementLeg['status'], number>> = {
  PENDING: 0,
  SUBMITTED: 1,
  CONFIRMED: 2,
  FAILED: 3,
};

export class PostgresRunSettlementLegStore implements RunSettlementLegStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async record(leg: RunSettlementLeg): Promise<void> {
    await this.#pool.query(
      `INSERT INTO run_settlement_legs (
         run_id, leg_index, kind, network, asset_symbol, asset_decimals, asset_address,
         status, transaction_hash, amount_atomic, provider, detail
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
       ON CONFLICT (run_id, leg_index) DO UPDATE SET
         status = EXCLUDED.status,
         -- COALESCE keeps a hash or amount already learned when a later write does not repeat it,
         -- so an update that only advances the status cannot erase earlier evidence.
         transaction_hash = COALESCE(EXCLUDED.transaction_hash, run_settlement_legs.transaction_hash),
         amount_atomic = COALESCE(EXCLUDED.amount_atomic, run_settlement_legs.amount_atomic),
         provider = COALESCE(EXCLUDED.provider, run_settlement_legs.provider),
         detail = COALESCE(EXCLUDED.detail, run_settlement_legs.detail),
         updated_at = now()
       WHERE $13 >= (
         CASE run_settlement_legs.status
           WHEN 'PENDING' THEN 0 WHEN 'SUBMITTED' THEN 1 WHEN 'CONFIRMED' THEN 2 ELSE 3
         END
       )`,
      [
        leg.runId,
        leg.legIndex,
        leg.kind,
        leg.network,
        leg.assetSymbol,
        leg.assetDecimals,
        leg.assetAddress ? hexToBuffer(leg.assetAddress) : null,
        leg.status,
        leg.transactionHash ? hexToBuffer(leg.transactionHash) : null,
        leg.amountAtomic ?? null,
        leg.provider ?? null,
        leg.detail ? JSON.stringify(leg.detail) : null,
        STATUS_RANK[leg.status],
      ],
    );
  }

  async listByRunId(runId: string): Promise<readonly RunSettlementLeg[]> {
    const result = await this.#pool.query<LegRow>(
      `SELECT run_id, leg_index, kind, network, asset_symbol, asset_decimals, asset_address,
              status, transaction_hash, amount_atomic::text, provider, detail
         FROM run_settlement_legs WHERE run_id = $1 ORDER BY leg_index`,
      [runId],
    );
    return result.rows.map(parseLeg);
  }
}

function parseLeg(row: LegRow): RunSettlementLeg {
  return {
    runId: row.run_id,
    legIndex: row.leg_index,
    kind: row.kind,
    network: row.network,
    assetSymbol: row.asset_symbol,
    assetDecimals: row.asset_decimals,
    ...(row.asset_address ? { assetAddress: bufferToHex(row.asset_address) } : {}),
    status: row.status,
    ...(row.transaction_hash ? { transactionHash: bufferToHex(row.transaction_hash) } : {}),
    ...(row.amount_atomic === null ? {} : { amountAtomic: row.amount_atomic }),
    ...(row.provider === null ? {} : { provider: row.provider }),
    ...(row.detail === null ? {} : { detail: row.detail }),
  };
}

function hexToBuffer(value: `0x${string}`): Buffer {
  return Buffer.from(value.slice(2), 'hex');
}

function bufferToHex(value: Buffer): `0x${string}` {
  return `0x${value.toString('hex')}`;
}
