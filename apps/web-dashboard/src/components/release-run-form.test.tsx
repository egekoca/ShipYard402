// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ReleaseRunForm } from './release-run-form';

const { createQuote, ensureSession, connectWallet, ensureChain, getAuthorizedAccount } = vi.hoisted(() => ({
  createQuote: vi.fn(),
  ensureSession: vi.fn(),
  connectWallet: vi.fn(),
  ensureChain: vi.fn(),
  getAuthorizedAccount: vi.fn(),
}));

vi.mock('@shipyard402/public-api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shipyard402/public-api-client')>();
  return {
    ...actual,
    ShipyardApiClient: class {
      createQuote = createQuote;
    },
  };
});

vi.mock('../lib/goat-wallet', () => ({
  connectWallet,
  ensureChain,
  getAuthorizedAccount,
  formatWalletError: (error: unknown) => (error instanceof Error ? error.message : 'Unexpected wallet error'),
  GOAT_TESTNET3_CHAIN_ID: 48816,
}));

vi.mock('../lib/session', () => ({
  ensureSession,
  getStoredSessionToken: () => null,
}));

vi.mock('../hooks/use-run-progress', () => ({
  useRunProgress: () => ({
    run: null,
    plan: null,
    evidence: null,
    attestation: null,
    error: null,
    lastPolledAt: null,
    activeStep: -1,
    isTerminal: false,
  }),
}));

vi.mock('./run-history', () => ({ RunHistory: () => null }));
vi.mock('./run-progress-panels', () => ({ RunProgressPanels: () => null }));
vi.mock('./service-onboarding', () => ({ ServiceOnboarding: () => null }));

const REQUESTER_ADDRESS = '0x3000000000000000000000000000000000000003';

beforeEach(() => {
  getAuthorizedAccount.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ReleaseRunForm', () => {
  it('asks to connect a wallet before anything can be submitted', async () => {
    render(<ReleaseRunForm />);
    expect(await screen.findByRole('button', { name: 'Connect wallet' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect a wallet first' })).toBeDisabled();
  });

  it('connects a wallet, then requests and displays a quote', async () => {
    connectWallet.mockResolvedValue(REQUESTER_ADDRESS);
    ensureChain.mockResolvedValue(undefined);
    ensureSession.mockResolvedValue('session-token');
    createQuote.mockResolvedValue({
      id: 'quote_1',
      pricingStatus: 'HYPOTHESIS',
      totalAtomicAmount: '1500000',
      refundableToolBudgetAtomic: '500000',
      createdAt: '2026-08-05T00:00:00.000Z',
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      quoteCommitment: '0xabc0000000000000000000000000000000000000000000000000000000000abc',
      capabilitySnapshot: {
        chainId: 48816,
        tokenAddress: '0x1000000000000000000000000000000000000001',
        tokenSymbol: 'USDC',
        tokenDecimals: 6,
        receivingAddress: '0x2000000000000000000000000000000000000002',
        mode: 'ERC20_DIRECT',
      },
      lineItems: {},
      nextAction: 'CREATE_GOAT_FLOW_ERC20_DIRECT_ORDER',
      warning: 'test',
    });

    const user = userEvent.setup();
    render(<ReleaseRunForm />);

    await user.click(await screen.findByRole('button', { name: 'Connect wallet' }));
    expect(connectWallet).toHaveBeenCalledOnce();

    const submit = await screen.findByRole('button', { name: 'Request transparent quote' });
    await user.click(submit);

    expect(createQuote).toHaveBeenCalledOnce();
    expect(await screen.findByText('1.500000')).toBeInTheDocument();
    expect(screen.getByText('USDC')).toBeInTheDocument();
  });

  it('surfaces the API error instead of a raw exception when quoting fails', async () => {
    connectWallet.mockResolvedValue(REQUESTER_ADDRESS);
    ensureChain.mockResolvedValue(undefined);
    ensureSession.mockResolvedValue('session-token');
    createQuote.mockRejectedValue(new Error('no reviewed merchant capability'));

    const user = userEvent.setup();
    render(<ReleaseRunForm />);

    await user.click(await screen.findByRole('button', { name: 'Connect wallet' }));
    await user.click(await screen.findByRole('button', { name: 'Request transparent quote' }));

    expect(await screen.findByText('no reviewed merchant capability')).toBeInTheDocument();
  });
});
