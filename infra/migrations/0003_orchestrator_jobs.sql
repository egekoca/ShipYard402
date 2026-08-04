BEGIN;

CREATE TABLE orchestrator_jobs (
  run_id text PRIMARY KEY REFERENCES runs(id),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN (
    'PENDING', 'PROCESSING', 'RETRY_SCHEDULED', 'COMPLETED', 'DEAD_LETTER'
  )),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  maximum_attempts integer NOT NULL DEFAULT 8 CHECK (maximum_attempts BETWEEN 1 AND 32),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  last_error_code text,
  failure_codes jsonb,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (attempts <= maximum_attempts),
  CHECK ((status = 'PROCESSING') = (locked_at IS NOT NULL AND locked_by IS NOT NULL)),
  CHECK ((status = 'COMPLETED') = (completed_at IS NOT NULL)),
  CHECK (failure_codes IS NULL OR jsonb_typeof(failure_codes) = 'array')
);

CREATE INDEX orchestrator_jobs_due_idx
  ON orchestrator_jobs (available_at, created_at)
  WHERE status IN ('PENDING', 'RETRY_SCHEDULED');

CREATE INDEX orchestrator_jobs_stale_idx
  ON orchestrator_jobs (locked_at)
  WHERE status = 'PROCESSING';

COMMIT;
