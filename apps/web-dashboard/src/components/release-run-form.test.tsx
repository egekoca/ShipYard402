// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ReleaseRunForm } from './release-run-form';

const {
  createQuote,
  createRun,
  requestPaymentChallenge,
  listMarketplaceServices,
  ensureSession,
  connectWallet,
  ensureChain,
  getAuthorizedAccount,
} = vi.hoisted(() => ({
  createQuote: vi.fn(),
  createRun: vi.fn(),
  requestPaymentChallenge: vi.fn(),
  listMarketplaceServices: vi.fn(),
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
      createRun = createRun;
      requestPaymentChallenge = requestPaymentChallenge;
      listMarketplaceServices = listMarketplaceServices;
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
const scrollIntoView = vi.fn();

/** A directory row, which is the only thing that can give the form a target to quote. */
const LISTING = {
  organizationId: '11111111-2222-3333-4444-555555555555',
  targetServiceId: 'service:acme-weather',
  targetAgentId: 'agent:service:acme-weather',
  targetVersionHash: '0xaaaa000000000000000000000000000000000000000000000000000000000aaa',
  policyHash: '0xbbbb000000000000000000000000000000000000000000000000000000000bbb',
  x402Endpoint: 'https://api.acme.com/paid/weather',
  openApiUrl: 'https://api.acme.com/openapi.json',
  name: 'Acme Weather',
  description: null,
  logoUrl: null,
  version: '2.1.0',
  chainId: 48816,
  listedAt: '2026-08-13T00:00:00.000Z',
};

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });
  getAuthorizedAccount.mockResolvedValue(null);
  // Most cases here are about the quote flow rather than the directory itself, but there is no
  // built-in target any more: a listing is what makes the form quotable at all.
  listMarketplaceServices.mockResolvedValue([LISTING]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/**
 * The service name also appears in the form's target summary once a listing is selected, so a
 * click meant for a directory card has to be scoped to the directory rather than matched globally.
 */
async function directory(): Promise<HTMLElement> {
  return screen.findByRole('region', { name: 'x402 service directory' });
}

describe('ReleaseRunForm', () => {
  it('asks to connect a wallet before anything can be submitted', async () => {
    render(<ReleaseRunForm />);
    expect(await screen.findByRole('button', { name: 'Connect wallet' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect a wallet first' })).toBeDisabled();
  });

  it('refuses to quote when the directory has nothing to target', async () => {
    // The form ships with no compiled-in target, so an empty directory means there is genuinely
    // nothing to quote -- saying so is honest, where quoting a fabricated endpoint would take a
    // real payment for a run whose target does not exist.
    listMarketplaceServices.mockResolvedValue([]);
    connectWallet.mockResolvedValue(REQUESTER_ADDRESS);
    ensureChain.mockResolvedValue(undefined);
    ensureSession.mockResolvedValue('session-token');

    const user = userEvent.setup();
    render(<ReleaseRunForm />);
    await user.click(await screen.findByRole('button', { name: 'Connect wallet' }));

    expect(await screen.findByRole('button', { name: 'Pick a target first' })).toBeDisabled();
    expect(screen.getByText(/No target selected yet/)).toBeInTheDocument();
    expect(createQuote).not.toHaveBeenCalled();
  });

  it('adopts the first listing so a visitor never lands on an unquotable form', async () => {
    connectWallet.mockResolvedValue(REQUESTER_ADDRESS);
    ensureChain.mockResolvedValue(undefined);
    ensureSession.mockResolvedValue('session-token');
    createQuote.mockRejectedValue(new Error('quote rejected'));

    const user = userEvent.setup();
    render(<ReleaseRunForm />);
    await user.click(await screen.findByRole('button', { name: 'Connect wallet' }));
    await user.click(await screen.findByRole('button', { name: 'Request transparent quote' }));

    expect(createQuote).toHaveBeenCalledWith(expect.objectContaining({ targetServiceId: LISTING.targetServiceId }));
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
    const createdRun = {
      run: {
        id: 'run_1',
        status: 'PAYMENT_REQUIRED',
        revision: 2,
        createdAt: '2026-08-18T00:00:00.000Z',
        updatedAt: '2026-08-18T00:00:00.000Z',
      },
      payment: { status: 'CHECKOUT_VERIFIED', mode: 'ERC20_DIRECT', nextAction: 'PAY_X402_CHALLENGE' },
    };
    createRun.mockResolvedValue(createdRun);
    requestPaymentChallenge.mockResolvedValue(createdRun);

    const user = userEvent.setup();
    render(<ReleaseRunForm />);

    await user.click(await screen.findByRole('button', { name: 'Connect wallet' }));
    expect(connectWallet).toHaveBeenCalledOnce();

    const submit = await screen.findByRole('button', { name: 'Request transparent quote' });
    await user.click(submit);

    expect(createQuote).toHaveBeenCalledOnce();
    expect(await screen.findByText('1.500000')).toBeInTheDocument();
    expect(screen.getByText('USDC')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Create idempotent run' }));
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' }));
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

  it('quotes exactly the service picked from the directory', async () => {
    const listing = LISTING;
    connectWallet.mockResolvedValue(REQUESTER_ADDRESS);
    ensureChain.mockResolvedValue(undefined);
    ensureSession.mockResolvedValue('session-token');
    createQuote.mockRejectedValue(new Error('quote rejected'));

    const user = userEvent.setup();
    render(<ReleaseRunForm />);

    await user.click(await screen.findByRole('button', { name: 'Connect wallet' }));
    await user.click(await within(await directory()).findByText('Acme Weather'));
    await user.click(await screen.findByRole('button', { name: 'Request transparent quote' }));

    // Every catalog identifier the quote binds against has to come from the listing -- a target
    // half-replaced (e.g. a new service id still carrying the fallback's org or version hash)
    // would fail to bind server-side rather than testing the service the person clicked.
    expect(createQuote).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: listing.organizationId,
        targetServiceId: listing.targetServiceId,
        targetAgentId: listing.targetAgentId,
        targetVersionHash: listing.targetVersionHash,
        policyHash: listing.policyHash,
        x402Endpoint: listing.x402Endpoint,
        openApiUrl: listing.openApiUrl,
        requesterAddress: REQUESTER_ADDRESS,
      }),
    );
  });

  it("switches to the selected catalog service's chain instead of the listing backend default", async () => {
    const listing = {
      organizationId: '22222222-3333-4444-5555-666666666666',
      targetServiceId: 'service:bnb-weather',
      targetAgentId: 'agent:service:bnb-weather',
      targetVersionHash: '0xaaaa000000000000000000000000000000000000000000000000000000000aaa',
      policyHash: '0xbbbb000000000000000000000000000000000000000000000000000000000bbb',
      x402Endpoint: 'https://api.bnb.example/paid/weather',
      openApiUrl: 'https://api.bnb.example/openapi.json',
      name: 'BNB Weather',
      description: null,
      logoUrl: null,
      version: '1.0.0',
      chainId: 56,
      listedAt: '2026-08-13T00:00:00.000Z',
    };
    listMarketplaceServices.mockResolvedValue([listing]);
    connectWallet.mockResolvedValue(REQUESTER_ADDRESS);
    ensureChain.mockResolvedValue(undefined);
    ensureSession.mockResolvedValue('session-token');
    const user = userEvent.setup();

    render(<ReleaseRunForm />);
    await user.click(await screen.findByRole('button', { name: 'Connect wallet' }));
    await user.click(await screen.findByRole('tab', { name: /BNB/ }));
    await user.click(await within(await directory()).findByText('BNB Weather'));

    expect(ensureChain).toHaveBeenLastCalledWith(56);
  });
});
