// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WalletPayPanel, type PaymentChallenge } from './wallet-pay-panel';

const { connectWallet, ensureChain, readErc20Balance, sendErc20Payment, isWalletAvailable } = vi.hoisted(() => ({
  connectWallet: vi.fn(),
  ensureChain: vi.fn(),
  readErc20Balance: vi.fn(),
  sendErc20Payment: vi.fn(),
  isWalletAvailable: vi.fn(),
}));

vi.mock('../lib/goat-wallet', () => ({
  connectWallet,
  ensureChain,
  readErc20Balance,
  sendErc20Payment,
  isWalletAvailable,
  formatWalletError: (error: unknown) => {
    const code = (error as { code?: number } | null)?.code;
    if (code === 4001) return 'Rejected in wallet.';
    return error instanceof Error ? error.message : 'Unexpected wallet error';
  },
}));

const challenge: PaymentChallenge = {
  network: 'goat-testnet3',
  amount: '1500000',
  asset: '0x1000000000000000000000000000000000000001',
  payTo: '0x2000000000000000000000000000000000000002',
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('WalletPayPanel', () => {
  it('shows manual-payment instructions when no wallet extension is detected', () => {
    isWalletAvailable.mockReturnValue(false);
    render(
      <WalletPayPanel runId="run-fixed" chainId={48816} challenge={challenge} tokenSymbol="USDC" tokenDecimals={6} />,
    );
    expect(screen.getByText(/No browser wallet detected/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('offers to connect a wallet when one is available but not yet connected', () => {
    isWalletAvailable.mockReturnValue(true);
    render(
      <WalletPayPanel runId="run-fixed" chainId={48816} challenge={challenge} tokenSymbol="USDC" tokenDecimals={6} />,
    );
    expect(screen.getByRole('button', { name: 'Connect wallet' })).toBeInTheDocument();
  });

  it('connects the wallet and then offers to pay once the network is ready', async () => {
    isWalletAvailable.mockReturnValue(true);
    connectWallet.mockResolvedValue('0x3000000000000000000000000000000000000003');
    ensureChain.mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(
      <WalletPayPanel runId="run-fixed" chainId={48816} challenge={challenge} tokenSymbol="USDC" tokenDecimals={6} />,
    );
    await user.click(screen.getByRole('button', { name: 'Connect wallet' }));

    expect(connectWallet).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Pay 1.500000 USDC' })).toBeInTheDocument());
  });

  it('skips the connect step when already connected elsewhere and pays on click', async () => {
    isWalletAvailable.mockReturnValue(true);
    ensureChain.mockResolvedValue(undefined);
    readErc20Balance.mockResolvedValue(2_000_000n);
    sendErc20Payment.mockResolvedValue('0x4000000000000000000000000000000000000000000000000000000000000004');
    const user = userEvent.setup();

    render(
      <WalletPayPanel
        runId="run-fixed"
        chainId={48816}
        challenge={challenge}
        tokenSymbol="USDC"
        tokenDecimals={6}
        connectedAddress="0x3000000000000000000000000000000000000003"
      />,
    );

    const payButton = await screen.findByRole('button', { name: 'Pay 1.500000 USDC' });
    await user.click(payButton);

    await waitFor(() =>
      expect(sendErc20Payment).toHaveBeenCalledWith({
        fromAddress: '0x3000000000000000000000000000000000000003',
        tokenAddress: challenge.asset,
        toAddress: challenge.payTo,
        amountAtomic: challenge.amount,
      }),
    );
    expect(await screen.findByText('Payment sent — confirming on-chain')).toBeInTheDocument();
  });

  it('blocks the transaction before signing when the selected-chain token balance is too low', async () => {
    isWalletAvailable.mockReturnValue(true);
    ensureChain.mockResolvedValue(undefined);
    readErc20Balance.mockResolvedValue(0n);
    const user = userEvent.setup();

    render(
      <WalletPayPanel
        runId="run-fixed"
        chainId={968}
        challenge={challenge}
        tokenSymbol="SHIPTEST"
        tokenDecimals={6}
        connectedAddress="0x3000000000000000000000000000000000000003"
      />,
    );

    await user.click(await screen.findByRole('button', { name: 'Pay 1.500000 SHIPTEST' }));

    expect(
      await screen.findByText('Insufficient SHIPTEST balance. Need 1.500000; wallet has 0.000000.'),
    ).toBeInTheDocument();
    expect(sendErc20Payment).not.toHaveBeenCalled();
  });

  it('surfaces a friendly message when the wallet rejects the connection request', async () => {
    isWalletAvailable.mockReturnValue(true);
    connectWallet.mockRejectedValue({ code: 4001 });
    const user = userEvent.setup();

    render(
      <WalletPayPanel runId="run-fixed" chainId={48816} challenge={challenge} tokenSymbol="USDC" tokenDecimals={6} />,
    );
    await user.click(screen.getByRole('button', { name: 'Connect wallet' }));

    expect(await screen.findByText('Rejected in wallet.')).toBeInTheDocument();
  });
});
