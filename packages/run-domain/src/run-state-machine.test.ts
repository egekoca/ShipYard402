import { describe, expect, it } from 'vitest';

import {
  IllegalRunTransitionError,
  RunRevisionConflictError,
  createDraftRun,
  transitionRun,
} from './run-state-machine.js';

const now = '2026-08-04T10:00:00.000Z';

describe('run state machine', () => {
  it('executes the funded-to-fail path with explicit actors', () => {
    let run = createDraftRun('run_01', now);
    const steps = [
      ['QUOTED', 'QUOTE_ENGINE'],
      ['PAYMENT_REQUIRED', 'MERCHANT_GATEWAY'],
      ['FUNDED', 'PAYMENT_RECONCILER'],
      ['ANALYZING', 'ORCHESTRATOR'],
      ['PLAN_COMPILED', 'POLICY_ENGINE'],
      ['PROCURING', 'PROCUREMENT_WORKER'],
      ['EXECUTING', 'EXECUTION_WORKER'],
      ['EVIDENCE_BUILDING', 'EXECUTION_WORKER'],
      ['ATTESTING', 'EVIDENCE_WORKER'],
      ['DELIVERED_FAIL', 'ATTESTOR'],
    ] as const;

    for (const [to, actor] of steps) {
      run = transitionRun(run, {
        actor,
        expectedRevision: run.revision,
        idempotencyKey: `command-${run.revision}-${to}`,
        occurredAt: now,
        to,
      }).run;
    }

    expect(run.status).toBe('DELIVERED_FAIL');
    expect(run.result).toBe('FAIL');
    expect(run.revision).toBe(10);
  });

  it('returns an idempotent replay without incrementing revision', () => {
    const run = createDraftRun('run_02', now);
    const command = {
      actor: 'QUOTE_ENGINE',
      expectedRevision: 0,
      idempotencyKey: 'quote-command-1',
      occurredAt: now,
      to: 'QUOTED',
    } as const;
    const first = transitionRun(run, command);
    const replay = transitionRun(first.run, command);

    expect(replay.idempotentReplay).toBe(true);
    expect(replay.event).toBeNull();
    expect(replay.run.revision).toBe(1);
  });

  it('rejects unauthorized and terminal transitions', () => {
    const draft = createDraftRun('run_03', now);
    expect(() =>
      transitionRun(draft, {
        actor: 'ORCHESTRATOR',
        expectedRevision: 0,
        idempotencyKey: 'bad-command-1',
        occurredAt: now,
        to: 'FUNDED',
      }),
    ).toThrow(IllegalRunTransitionError);
  });

  it('detects optimistic concurrency conflicts', () => {
    const draft = createDraftRun('run_04', now);
    expect(() =>
      transitionRun(draft, {
        actor: 'QUOTE_ENGINE',
        expectedRevision: 9,
        idempotencyKey: 'quote-command-2',
        occurredAt: now,
        to: 'QUOTED',
      }),
    ).toThrow(RunRevisionConflictError);
  });
});
