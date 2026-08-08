// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RunDetail } from './run-detail';

const { connectWallet, getAuthorizedAccount, ensureSession, useRunProgress } = vi.hoisted(() => ({
  connectWallet: vi.fn(),
  getAuthorizedAccount: vi.fn(),
  ensureSession: vi.fn(),
  useRunProgress: vi.fn(),
}));

vi.mock('../lib/goat-wallet', () => ({
  connectWallet,
  getAuthorizedAccount,
  formatWalletError: (error: unknown) => (error instanceof Error ? error.message : 'Unexpected wallet error'),
}));

vi.mock('../lib/session', () => ({ ensureSession }));
vi.mock('../hooks/use-run-progress', () => ({ useRunProgress }));
vi.mock('./site-header', () => ({ SiteHeader: () => null }));
vi.mock('./run-progress-panels', () => ({
  RunProgressPanels: ({ runId }: { runId: string }) => <div data-testid="run-progress-panels">{runId}</div>,
}));

const RUN_ID = 'run_test_1';
const IDLE_PROGRESS = {
  run: null,
  plan: null,
  evidence: null,
  attestation: null,
  error: null,
  lastPolledAt: null,
  activeStep: -1,
  isTerminal: false,
};

beforeEach(() => {
  getAuthorizedAccount.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('RunDetail', () => {
  it('shows a loading state before the run is found and no error has occurred', () => {
    useRunProgress.mockReturnValue(IDLE_PROGRESS);
    render(<RunDetail runId={RUN_ID} />);
    expect(screen.getByText('Looking up run…')).toBeInTheDocument();
  });

  it('renders the run progress panels once the run is found', () => {
    useRunProgress.mockReturnValue({ ...IDLE_PROGRESS, run: { run: { id: RUN_ID, status: 'EXECUTING' } } });
    render(<RunDetail runId={RUN_ID} />);
    expect(screen.getByTestId('run-progress-panels')).toHaveTextContent(RUN_ID);
    expect(screen.queryByText('Looking up run…')).not.toBeInTheDocument();
  });

  it('shows a generic blocked message for a non-auth error', () => {
    useRunProgress.mockReturnValue({ ...IDLE_PROGRESS, error: 'RUN_NOT_FOUND: no such run' });
    render(<RunDetail runId={RUN_ID} />);
    expect(screen.getByText('Request blocked')).toBeInTheDocument();
    expect(screen.getByText('RUN_NOT_FOUND: no such run')).toBeInTheDocument();
  });

  it('asks the caller to connect the owning wallet on an AUTH_ error, and reconnects on click', async () => {
    useRunProgress.mockReturnValue({ ...IDLE_PROGRESS, error: 'AUTH_REQUIRED' });
    connectWallet.mockResolvedValue('0x3000000000000000000000000000000000000003');
    ensureSession.mockResolvedValue('session-token');
    const user = userEvent.setup();

    render(<RunDetail runId={RUN_ID} />);
    expect(screen.getByText('Connect the wallet that requested this run')).toBeInTheDocument();
    expect(screen.queryByText('Request blocked')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Connect wallet' }));
    await waitFor(() =>
      expect(ensureSession).toHaveBeenCalledWith(expect.anything(), '0x3000000000000000000000000000000000000003'),
    );
  });
});
