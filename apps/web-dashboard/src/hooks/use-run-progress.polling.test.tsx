// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getRun = vi.fn();
const getPlan = vi.fn();
const getEvidence = vi.fn();
const getAttestation = vi.fn();

// Declared inside the factory: vi.mock is hoisted above every top-level binding in this file, so
// a class declared out here would not exist yet when the factory runs.
vi.mock('@shipyard402/public-api-client', () => ({
  ShipyardApiClient: class {
    getRun = getRun;
    getPlan = getPlan;
    getEvidence = getEvidence;
    getAttestation = getAttestation;
    getStepDurationStats = vi.fn(async () => null);
  },
  ShipyardApiError: class extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));

vi.mock('../lib/session', () => ({ getStoredSessionToken: () => 'token' }));

import { ShipyardApiError } from '@shipyard402/public-api-client';

import { useRunProgress } from './use-run-progress';

// The mocked constructor above, typed for the two-argument shape this suite constructs it with.
const ApiError = ShipyardApiError as unknown as new (code: string, message: string) => Error;

function runResponse(status: string) {
  return { run: { id: 'run-1', status } };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  getRun.mockReset().mockResolvedValue(runResponse('PROCURING'));
  getPlan.mockReset().mockResolvedValue({ runId: 'run-1' });
  getEvidence.mockReset().mockResolvedValue({ runId: 'run-1' });
  getAttestation.mockReset().mockResolvedValue({ runId: 'run-1' });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useRunProgress', () => {
  it('fetches nothing and holds empty state when there is no run to follow', async () => {
    const { result } = renderHook(() => useRunProgress(null));

    expect(getRun).not.toHaveBeenCalled();
    expect(result.current.run).toBeNull();
    expect(result.current.activeStep).toBe(-1);
    expect(result.current.isTerminal).toBe(false);
  });

  it('loads the run with its plan, evidence, and attestation on the first poll', async () => {
    const { result } = renderHook(() => useRunProgress('run-1'));

    await waitFor(() => expect(result.current.run).not.toBeNull());
    expect(result.current.plan).toEqual({ runId: 'run-1' });
    expect(result.current.evidence).toEqual({ runId: 'run-1' });
    expect(result.current.attestation).toEqual({ runId: 'run-1' });
    expect(result.current.lastPolledAt).toBeInstanceOf(Date);
    expect(result.current.error).toBeNull();
  });

  it('derives the active step and terminal flag from the run status', async () => {
    getRun.mockResolvedValue(runResponse('DELIVERED_PASS'));
    const { result } = renderHook(() => useRunProgress('run-1'));

    await waitFor(() => expect(result.current.isTerminal).toBe(true));
    expect(result.current.activeStep).toBe(5);
  });

  it('keeps polling an in-flight run', async () => {
    renderHook(() => useRunProgress('run-1'));
    await waitFor(() => expect(getRun).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(4_000);

    await waitFor(() => expect(getRun.mock.calls.length).toBeGreaterThan(1));
  });

  /** A terminal run is finished; continuing to hammer the API at the live rate buys nothing. */
  it('backs off once the run reaches a terminal status', async () => {
    getRun.mockResolvedValue(runResponse('DELIVERED_PASS'));
    const { result } = renderHook(() => useRunProgress('run-1'));
    await waitFor(() => expect(result.current.isTerminal).toBe(true));

    const settled = getRun.mock.calls.length;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(getRun.mock.calls.length).toBe(settled);

    await vi.advanceTimersByTimeAsync(12_000);
    await waitFor(() => expect(getRun.mock.calls.length).toBeGreaterThan(settled));
  });

  it("surfaces an API error's code and message", async () => {
    getRun.mockRejectedValue(new ApiError('RUN_NOT_FOUND', 'No such run'));
    const { result } = renderHook(() => useRunProgress('run-1'));

    await waitFor(() => expect(result.current.error).toBe('RUN_NOT_FOUND: No such run'));
  });

  it('reports an unreachable API generically rather than leaking a transport error', async () => {
    getRun.mockRejectedValue(new TypeError('fetch failed'));
    const { result } = renderHook(() => useRunProgress('run-1'));

    await waitFor(() => expect(result.current.error).toBe('Could not reach the Shipyard402 API'));
  });

  it('clears a previous error once a later poll succeeds', async () => {
    getRun.mockRejectedValueOnce(new TypeError('fetch failed'));
    const { result } = renderHook(() => useRunProgress('run-1'));
    await waitFor(() => expect(result.current.error).not.toBeNull());

    await vi.advanceTimersByTimeAsync(4_000);

    await waitFor(() => expect(result.current.error).toBeNull());
  });

  it('stops polling once unmounted', async () => {
    const { unmount } = renderHook(() => useRunProgress('run-1'));
    await waitFor(() => expect(getRun).toHaveBeenCalled());

    unmount();
    const afterUnmount = getRun.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);

    expect(getRun.mock.calls.length).toBe(afterUnmount);
  });

  /** Switching runs must not let the previous run's in-flight fetch resolve into the new run's
   * state -- the exact race the per-invocation `cancelled` flag exists to prevent. Every poll after
   * the switch is frozen, so nothing can quietly repair a stale write after the fact. */
  it('ignores a slow response from a run that is no longer being followed', async () => {
    let releaseStale: (value: unknown) => void = () => {};
    getRun.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseStale = resolve;
        }),
    );

    const { result, rerender } = renderHook(({ id }) => useRunProgress(id), {
      initialProps: { id: 'run-1' as string | null },
    });
    await waitFor(() => expect(getRun).toHaveBeenCalledTimes(1));

    getRun.mockResolvedValue(runResponse('DELIVERED_FAIL'));
    rerender({ id: 'run-2' });
    await waitFor(() => expect(result.current.run?.run.status).toBe('DELIVERED_FAIL'));

    // From here on nothing resolves, so the only thing that could still change the status is the
    // abandoned run-1 fetch released below.
    getRun.mockImplementation(() => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(20_000);

    // act() so any state update the abandoned fetch triggers is actually flushed and rendered --
    // without it a missing guard would still be a passing test.
    await act(async () => {
      releaseStale(runResponse('PROCURING'));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.run?.run.status).toBe('DELIVERED_FAIL');
  });
});
