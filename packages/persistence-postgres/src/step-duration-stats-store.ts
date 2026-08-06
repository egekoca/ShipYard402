import type { Pool, QueryResultRow } from 'pg';

/**
 * The five stages the frontend's pipeline stepper shows -- each bucket sums the run_events
 * transition(s) that occur while that stage is the active one, so a bucket's median lines up with
 * how long a run visibly sits on that step, not with the state machine's internal transitions.
 */
export type StepDurationBucket = 'payment' | 'plan' | 'procurement' | 'evidence' | 'attestation';

export type StepDurationStats = Readonly<{
  /** Number of completed runs the medians were computed from -- smallest bucket sample size. */
  sampleSize: number;
  medianMillisecondsByStep: Readonly<Partial<Record<StepDurationBucket, number>>>;
}>;

export interface StepDurationStatsStore {
  getRecentMedianDurations(sampleRuns?: number): Promise<StepDurationStats | null>;
}

type StepDurationRow = QueryResultRow & {
  bucket: StepDurationBucket;
  median_ms: string;
  sample_size: string;
};

export class PostgresStepDurationStatsStore implements StepDurationStatsStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async getRecentMedianDurations(sampleRuns = 30): Promise<StepDurationStats | null> {
    const result = await this.#pool.query<StepDurationRow>(
      `
      WITH recent_runs AS (
        SELECT id FROM runs WHERE status::text LIKE 'DELIVERED%' ORDER BY updated_at DESC LIMIT $1
      ),
      transitions AS (
        SELECT
          e.run_id,
          e.payload->>'to' AS to_status,
          EXTRACT(EPOCH FROM (
            e.occurred_at - LAG(e.occurred_at) OVER (PARTITION BY e.run_id ORDER BY e.occurred_at)
          )) * 1000 AS duration_ms
        FROM run_events e
        WHERE e.run_id IN (SELECT id FROM recent_runs)
      ),
      bucketed AS (
        SELECT
          run_id,
          CASE
            WHEN to_status = 'FUNDED' THEN 'payment'
            WHEN to_status IN ('PLAN_COMPILED', 'PROCURING') THEN 'plan'
            WHEN to_status IN ('EXECUTING', 'EVIDENCE_BUILDING') THEN 'procurement'
            WHEN to_status = 'ATTESTING' THEN 'evidence'
            WHEN to_status LIKE 'DELIVERED%' THEN 'attestation'
          END AS bucket,
          duration_ms
        FROM transitions
        WHERE duration_ms IS NOT NULL AND to_status IS NOT NULL
      ),
      per_run_bucket AS (
        SELECT run_id, bucket, SUM(duration_ms) AS total_ms
        FROM bucketed
        WHERE bucket IS NOT NULL
        GROUP BY run_id, bucket
      )
      SELECT bucket, percentile_cont(0.5) WITHIN GROUP (ORDER BY total_ms) AS median_ms, COUNT(*) AS sample_size
      FROM per_run_bucket
      GROUP BY bucket
      `,
      [sampleRuns],
    );

    if (result.rows.length === 0) return null;

    const medianMillisecondsByStep: Partial<Record<StepDurationBucket, number>> = {};
    let smallestSampleSize = Number.POSITIVE_INFINITY;
    for (const row of result.rows) {
      medianMillisecondsByStep[row.bucket] = Math.round(Number(row.median_ms));
      smallestSampleSize = Math.min(smallestSampleSize, Number(row.sample_size));
    }
    return { sampleSize: smallestSampleSize, medianMillisecondsByStep };
  }
}
