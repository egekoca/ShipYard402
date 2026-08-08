import type { Pool, QueryResultRow } from 'pg';

const errorCodePattern = /^[A-Z0-9_]{1,100}$/;

export type ClaimedOrchestratorJob = Readonly<{
  runId: string;
  attempt: number;
  maximumAttempts: number;
  leaseOwner: string;
}>;

export type OrchestratorJobRecord = Readonly<{
  runId: string;
  status: 'PENDING' | 'PROCESSING' | 'RETRY_SCHEDULED' | 'COMPLETED' | 'DEAD_LETTER';
  attempts: number;
  maximumAttempts: number;
  availableAt: string;
  lockedAt?: string;
  lockedBy?: string;
  lastErrorCode?: string;
  failureCodes?: readonly string[];
  completedAt?: string;
}>;

type JobRow = QueryResultRow & {
  run_id: string;
  status: OrchestratorJobRecord['status'];
  attempts: number;
  maximum_attempts: number;
  available_at: Date | string;
  locked_at: Date | string | null;
  locked_by: string | null;
  last_error_code: string | null;
  failure_codes: unknown;
  completed_at: Date | string | null;
};

export class PostgresOrchestratorJobQueue {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async claimNext(
    input: Readonly<{
      workerId: string;
      leaseDurationSeconds: number;
    }>,
  ): Promise<ClaimedOrchestratorJob | null> {
    validateWorkerId(input.workerId);
    if (
      !Number.isInteger(input.leaseDurationSeconds) ||
      input.leaseDurationSeconds < 5 ||
      input.leaseDurationSeconds > 600
    ) {
      throw new Error('Orchestrator job lease duration must be between 5 and 600 seconds');
    }
    // A worker that hard-crashes while holding the lease on its last allowed attempt leaves a
    // PROCESSING row with a stale lock and attempts already at the cap. The reclaim branch below
    // only ever picks up rows with attempts < maximum_attempts, so without this sweep such a row
    // would sit in PROCESSING forever -- never retried, never dead-lettered, invisible to anyone.
    await this.#pool.query(
      `UPDATE orchestrator_jobs SET
         status = 'DEAD_LETTER', locked_at = NULL, locked_by = NULL,
         last_error_code = 'STALE_LEASE_ATTEMPTS_EXHAUSTED', updated_at = now()
       WHERE status = 'PROCESSING'
         AND locked_at <= now() - make_interval(secs => $1::int)
         AND attempts >= maximum_attempts`,
      [input.leaseDurationSeconds],
    );
    const result = await this.#pool.query<JobRow>(
      `WITH candidate AS (
         SELECT run_id, status
         FROM orchestrator_jobs
         WHERE (
           status IN ('PENDING', 'RETRY_SCHEDULED')
           AND available_at <= now()
           AND attempts < maximum_attempts
         ) OR (
           status = 'PROCESSING'
           AND locked_at <= now() - make_interval(secs => $2::int)
           AND attempts < maximum_attempts
         )
         ORDER BY available_at, created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE orchestrator_jobs job SET
         status = 'PROCESSING',
         attempts = job.attempts + CASE WHEN candidate.status = 'PROCESSING' THEN 0 ELSE 1 END,
         locked_at = now(),
         locked_by = $1,
         updated_at = now()
       FROM candidate
       WHERE job.run_id = candidate.run_id
       RETURNING job.*`,
      [input.workerId, input.leaseDurationSeconds],
    );
    const row = result.rows[0];
    return row
      ? {
          runId: row.run_id,
          attempt: row.attempts,
          maximumAttempts: row.maximum_attempts,
          leaseOwner: input.workerId,
        }
      : null;
  }

  async markCompleted(job: ClaimedOrchestratorJob): Promise<void> {
    await this.#finishLease(
      job,
      `UPDATE orchestrator_jobs SET
         status = 'COMPLETED', locked_at = NULL, locked_by = NULL,
         last_error_code = NULL, failure_codes = NULL, completed_at = now(), updated_at = now()
       WHERE run_id = $1 AND status = 'PROCESSING' AND locked_by = $2 AND attempts = $3`,
      [],
    );
  }

  async markRetry(job: ClaimedOrchestratorJob, delayMilliseconds: number, reason: string): Promise<void> {
    validateErrorCode(reason);
    if (!Number.isInteger(delayMilliseconds) || delayMilliseconds < 0 || delayMilliseconds > 3_600_000) {
      throw new Error('Orchestrator job retry delay must be between zero and one hour');
    }
    await this.#finishLease(
      job,
      `UPDATE orchestrator_jobs SET
         status = 'RETRY_SCHEDULED', locked_at = NULL, locked_by = NULL,
         available_at = now() + ($4::double precision * interval '1 millisecond'),
         last_error_code = $5, failure_codes = NULL, updated_at = now()
       WHERE run_id = $1 AND status = 'PROCESSING' AND locked_by = $2 AND attempts = $3`,
      [delayMilliseconds, reason],
    );
  }

  async markDeadLetter(
    job: ClaimedOrchestratorJob,
    reason: string,
    failureCodes: readonly string[] = [],
  ): Promise<void> {
    validateErrorCode(reason);
    failureCodes.forEach(validateErrorCode);
    await this.#finishLease(
      job,
      `UPDATE orchestrator_jobs SET
         status = 'DEAD_LETTER', locked_at = NULL, locked_by = NULL,
         last_error_code = $4, failure_codes = $5::jsonb, updated_at = now()
       WHERE run_id = $1 AND status = 'PROCESSING' AND locked_by = $2 AND attempts = $3`,
      [reason, JSON.stringify(failureCodes)],
    );
  }

  async findByRunId(runId: string): Promise<OrchestratorJobRecord | null> {
    const result = await this.#pool.query<JobRow>(`SELECT * FROM orchestrator_jobs WHERE run_id = $1`, [runId]);
    const row = result.rows[0];
    return row ? parseRecord(row) : null;
  }

  async #finishLease(
    job: ClaimedOrchestratorJob,
    sql: string,
    additionalParameters: readonly unknown[],
  ): Promise<void> {
    validateWorkerId(job.leaseOwner);
    if (!job.runId || !Number.isInteger(job.attempt) || job.attempt < 1) {
      throw new Error('Invalid claimed orchestrator job');
    }
    const result = await this.#pool.query(sql, [job.runId, job.leaseOwner, job.attempt, ...additionalParameters]);
    if (result.rowCount !== 1) throw new Error('Orchestrator job lease ownership conflict');
  }
}

function parseRecord(row: JobRow): OrchestratorJobRecord {
  const failureCodes = parseFailureCodes(row.failure_codes);
  return {
    runId: row.run_id,
    status: row.status,
    attempts: row.attempts,
    maximumAttempts: row.maximum_attempts,
    availableAt: toIso(row.available_at),
    ...(row.locked_at ? { lockedAt: toIso(row.locked_at) } : {}),
    ...(row.locked_by ? { lockedBy: row.locked_by } : {}),
    ...(row.last_error_code ? { lastErrorCode: row.last_error_code } : {}),
    ...(failureCodes ? { failureCodes } : {}),
    ...(row.completed_at ? { completedAt: toIso(row.completed_at) } : {}),
  };
}

function parseFailureCodes(value: unknown): readonly string[] | undefined {
  if (value === null) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && errorCodePattern.test(item))) {
    throw new Error('Invalid orchestrator job failure code payload in PostgreSQL');
  }
  return value;
}

function validateWorkerId(value: string): void {
  if (!/^[a-zA-Z0-9:_-]{1,200}$/.test(value)) throw new Error('Invalid orchestrator worker ID');
}

function validateErrorCode(value: string): void {
  if (!errorCodePattern.test(value)) throw new Error('Invalid orchestrator job error code');
}

function toIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid PostgreSQL timestamp');
  return date.toISOString();
}
