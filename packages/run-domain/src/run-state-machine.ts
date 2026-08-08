export const RUN_STATUSES = [
  'DRAFT',
  'QUOTED',
  'PAYMENT_REQUIRED',
  'FUNDED',
  'ANALYZING',
  'PLAN_COMPILED',
  'PROCURING',
  'EXECUTING',
  'REPLANNING',
  'EVIDENCE_BUILDING',
  'ATTESTING',
  'DELIVERED_PASS',
  'DELIVERED_CONDITIONAL',
  'DELIVERED_FAIL',
  'DELIVERED_INCONCLUSIVE',
  'CANCELLED',
  'EXPIRED',
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_RESULTS = ['PASS', 'CONDITIONAL', 'FAIL', 'INCONCLUSIVE'] as const;
export type RunResult = (typeof RUN_RESULTS)[number];

export const RUN_ACTORS = [
  'REQUESTER',
  'QUOTE_ENGINE',
  'MERCHANT_GATEWAY',
  'PAYMENT_RECONCILER',
  'ORCHESTRATOR',
  'POLICY_ENGINE',
  'PROCUREMENT_WORKER',
  'EXECUTION_WORKER',
  'EVIDENCE_WORKER',
  'ATTESTOR',
  'SYSTEM',
] as const;

export type RunActor = (typeof RUN_ACTORS)[number];

const TERMINAL_STATUSES = new Set<RunStatus>([
  'DELIVERED_PASS',
  'DELIVERED_CONDITIONAL',
  'DELIVERED_FAIL',
  'DELIVERED_INCONCLUSIVE',
  'CANCELLED',
  'EXPIRED',
]);

type TransitionRule = Readonly<{
  actors: ReadonlySet<RunActor>;
  to: RunStatus;
}>;

const rules = (...entries: Array<[RunStatus, RunActor[]]>): readonly TransitionRule[] =>
  entries.map(([to, actors]) => ({ to, actors: new Set(actors) }));

const TRANSITIONS: Readonly<Record<RunStatus, readonly TransitionRule[]>> = {
  DRAFT: rules(['QUOTED', ['QUOTE_ENGINE']], ['CANCELLED', ['REQUESTER', 'SYSTEM']], ['EXPIRED', ['SYSTEM']]),
  QUOTED: rules(
    ['PAYMENT_REQUIRED', ['MERCHANT_GATEWAY']],
    ['CANCELLED', ['REQUESTER', 'SYSTEM']],
    ['EXPIRED', ['SYSTEM']],
  ),
  PAYMENT_REQUIRED: rules(
    ['FUNDED', ['PAYMENT_RECONCILER']],
    ['CANCELLED', ['REQUESTER', 'SYSTEM']],
    ['EXPIRED', ['SYSTEM']],
  ),
  FUNDED: rules(['ANALYZING', ['ORCHESTRATOR']]),
  ANALYZING: rules(['PLAN_COMPILED', ['POLICY_ENGINE']], ['EVIDENCE_BUILDING', ['ORCHESTRATOR', 'SYSTEM']]),
  PLAN_COMPILED: rules(['PROCURING', ['PROCUREMENT_WORKER']], ['EVIDENCE_BUILDING', ['POLICY_ENGINE', 'SYSTEM']]),
  PROCURING: rules(
    ['EXECUTING', ['PROCUREMENT_WORKER', 'EXECUTION_WORKER']],
    ['REPLANNING', ['ORCHESTRATOR']],
    ['EVIDENCE_BUILDING', ['PROCUREMENT_WORKER', 'SYSTEM']],
  ),
  EXECUTING: rules(['REPLANNING', ['ORCHESTRATOR']], ['EVIDENCE_BUILDING', ['EXECUTION_WORKER', 'SYSTEM']]),
  REPLANNING: rules(
    ['PROCURING', ['POLICY_ENGINE', 'PROCUREMENT_WORKER']],
    ['EXECUTING', ['POLICY_ENGINE', 'EXECUTION_WORKER']],
    ['EVIDENCE_BUILDING', ['ORCHESTRATOR', 'SYSTEM']],
  ),
  EVIDENCE_BUILDING: rules(['ATTESTING', ['EVIDENCE_WORKER']]),
  ATTESTING: rules(
    ['DELIVERED_PASS', ['ATTESTOR']],
    ['DELIVERED_CONDITIONAL', ['ATTESTOR']],
    ['DELIVERED_FAIL', ['ATTESTOR']],
    ['DELIVERED_INCONCLUSIVE', ['ATTESTOR']],
  ),
  DELIVERED_PASS: [],
  DELIVERED_CONDITIONAL: [],
  DELIVERED_FAIL: [],
  DELIVERED_INCONCLUSIVE: [],
  CANCELLED: [],
  EXPIRED: [],
};

export type RunAggregate = Readonly<{
  id: string;
  status: RunStatus;
  result?: RunResult;
  revision: number;
  createdAt: string;
  updatedAt: string;
  appliedIdempotencyKeys: readonly string[];
}>;

export type TransitionCommand = Readonly<{
  actor: RunActor;
  expectedRevision: number;
  idempotencyKey: string;
  occurredAt: string;
  to: RunStatus;
}>;

export type RunTransitionedEvent = Readonly<{
  type: 'run.transitioned';
  runId: string;
  from: RunStatus;
  to: RunStatus;
  actor: RunActor;
  revision: number;
  idempotencyKey: string;
  occurredAt: string;
}>;

export type TransitionResult = Readonly<{
  run: RunAggregate;
  event: RunTransitionedEvent | null;
  idempotentReplay: boolean;
}>;

export class IllegalRunTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IllegalRunTransitionError';
  }
}
export class RunRevisionConflictError extends Error {
  constructor(expected: number, actual: number) {
    super(`Run revision conflict: expected ${expected}, actual ${actual}`);
    this.name = 'RunRevisionConflictError';
  }
}

export function createDraftRun(id: string, now: string): RunAggregate {
  if (id.length === 0) throw new Error('Run id is required');
  assertIsoDate(now, 'now');

  return {
    id,
    status: 'DRAFT',
    revision: 0,
    createdAt: now,
    updatedAt: now,
    appliedIdempotencyKeys: [],
  };
}

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function transitionRun(run: RunAggregate, command: TransitionCommand): TransitionResult {
  if (run.appliedIdempotencyKeys.includes(command.idempotencyKey)) {
    return { run, event: null, idempotentReplay: true };
  }

  if (command.idempotencyKey.length < 8) {
    throw new IllegalRunTransitionError('Idempotency key must contain at least 8 characters');
  }

  if (run.revision !== command.expectedRevision) {
    throw new RunRevisionConflictError(command.expectedRevision, run.revision);
  }

  assertIsoDate(command.occurredAt, 'occurredAt');

  if (Date.parse(command.occurredAt) < Date.parse(run.updatedAt)) {
    throw new IllegalRunTransitionError('Transition time cannot precede the previous event');
  }

  const rule = TRANSITIONS[run.status].find((candidate) => candidate.to === command.to);
  if (!rule?.actors.has(command.actor)) {
    throw new IllegalRunTransitionError(`${command.actor} cannot transition a run from ${run.status} to ${command.to}`);
  }

  const revision = run.revision + 1;
  const result = resultForTerminalStatus(command.to);
  const nextRun: RunAggregate = {
    ...run,
    status: command.to,
    ...(result === undefined ? {} : { result }),
    revision,
    updatedAt: command.occurredAt,
    appliedIdempotencyKeys: [...run.appliedIdempotencyKeys, command.idempotencyKey],
  };

  return {
    run: nextRun,
    idempotentReplay: false,
    event: {
      type: 'run.transitioned',
      runId: run.id,
      from: run.status,
      to: command.to,
      actor: command.actor,
      revision,
      idempotencyKey: command.idempotencyKey,
      occurredAt: command.occurredAt,
    },
  };
}

function resultForTerminalStatus(status: RunStatus): RunResult | undefined {
  switch (status) {
    case 'DELIVERED_PASS':
      return 'PASS';
    case 'DELIVERED_CONDITIONAL':
      return 'CONDITIONAL';
    case 'DELIVERED_FAIL':
      return 'FAIL';
    case 'DELIVERED_INCONCLUSIVE':
      return 'INCONCLUSIVE';
    default:
      return undefined;
  }
}

function assertIsoDate(value: string, field: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${field} must be an ISO date string`);
}
