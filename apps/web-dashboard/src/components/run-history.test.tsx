// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RunHistory } from './run-history';

const { listRuns, ensureSession } = vi.hoisted(() => ({
  listRuns: vi.fn(),
  ensureSession: vi.fn(),
}));

vi.mock('@shipyard402/public-api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shipyard402/public-api-client')>();
  return {
    ...actual,
    ShipyardApiClient: class {
      listRuns = listRuns;
    },
  };
});

vi.mock('../lib/session', () => ({
  ensureSession,
  getStoredSessionToken: () => null,
}));

const REQUESTER_ADDRESS = '0x3000000000000000000000000000000000000003';

function run(overrides: Partial<{ id: string; status: string; result?: string }> = {}) {
  return {
    id: overrides.id ?? 'run_1',
    status: overrides.status ?? 'DELIVERED_PASS',
    result: overrides.result,
    targetServiceId: 'service:x402-demo-target:testnet3-real-merchant',
    createdAt: '2026-08-05T00:00:00.000Z',
    updatedAt: '2026-08-05T00:05:00.000Z',
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('RunHistory', () => {
  it('shows a loading message before the first page resolves', () => {
    ensureSession.mockReturnValue(new Promise(() => {}));
    render(<RunHistory requesterAddress={REQUESTER_ADDRESS} />);
    expect(screen.getByText(/Looking up runs for/)).toBeInTheDocument();
  });

  it('renders nothing once loaded with zero past runs, instead of an empty table', async () => {
    ensureSession.mockResolvedValue('session-token');
    listRuns.mockResolvedValue({ runs: [], hasMore: false });
    const { container } = render(<RunHistory requesterAddress={REQUESTER_ADDRESS} />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('renders nothing when loading the first page fails (fails silently rather than showing an error card)', async () => {
    ensureSession.mockRejectedValue(new Error('network down'));
    const { container } = render(<RunHistory requesterAddress={REQUESTER_ADDRESS} />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('lists past runs with a human status label and an Open link per row', async () => {
    ensureSession.mockResolvedValue('session-token');
    listRuns.mockResolvedValue({
      runs: [run({ id: 'run_1', status: 'DELIVERED_PASS', result: 'PASS' }), run({ id: 'run_2', status: 'EXECUTING' })],
      hasMore: false,
    });

    render(<RunHistory requesterAddress={REQUESTER_ADDRESS} />);

    expect(await screen.findByText('PASS')).toBeInTheDocument();
    expect(screen.getByText('EXECUTING')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Open ↗' })).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
  });

  it('shows five runs per page and preserves the absolute row numbers', async () => {
    ensureSession.mockResolvedValue('session-token');
    listRuns.mockResolvedValue({
      runs: Array.from({ length: 7 }, (_, index) => run({ id: `run_${index + 1}` })),
      hasMore: false,
    });
    const user = userEvent.setup();

    render(<RunHistory requesterAddress={REQUESTER_ADDRESS} />);

    expect(await screen.findAllByRole('link', { name: 'Open ↗' })).toHaveLength(5);
    expect(screen.getByRole('button', { name: 'Page 1' })).toHaveAttribute('aria-current', 'page');
    await user.click(screen.getByRole('button', { name: 'Next page' }));

    expect(screen.getAllByRole('link', { name: 'Open ↗' })).toHaveLength(2);
    expect(screen.getByTitle('run_6')).toBeInTheDocument();
    expect(screen.getByText('6')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Page 2' })).toHaveAttribute('aria-current', 'page');
  });

  it('loads the next API batch when navigating beyond the loaded runs', async () => {
    ensureSession.mockResolvedValue('session-token');
    listRuns
      .mockResolvedValueOnce({
        runs: Array.from({ length: 5 }, (_, index) => run({ id: `run_${index + 1}` })),
        hasMore: true,
      })
      .mockResolvedValueOnce({ runs: [run({ id: 'run_6' }), run({ id: 'run_7' })], hasMore: false });
    const user = userEvent.setup();

    render(<RunHistory requesterAddress={REQUESTER_ADDRESS} />);
    await user.click(await screen.findByRole('button', { name: 'Next page' }));

    await waitFor(() => expect(listRuns).toHaveBeenLastCalledWith(REQUESTER_ADDRESS, { limit: 20, offset: 5 }));
    expect(await screen.findAllByRole('link', { name: 'Open ↗' })).toHaveLength(2);
    expect(screen.getByTitle('run_6')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
  });
});
