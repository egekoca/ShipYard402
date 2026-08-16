// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ExplorerTxLink } from './explorer-tx-link';

afterEach(cleanup);

const TX_HASH = `0x${'ab'.repeat(32)}`;

describe('ExplorerTxLink', () => {
  it('links a GOAT Testnet3 hash to the Testnet3 explorer', () => {
    render(
      <ExplorerTxLink chainId={48816} txHash={TX_HASH}>
        view tx
      </ExplorerTxLink>,
    );
    const link = screen.getByRole('link', { name: 'view tx' });
    expect(link).toHaveAttribute('href', `https://explorer.testnet3.goat.network/tx/${TX_HASH}`);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });

  it('sends a BNB hash to BscScan rather than a GOAT explorer', () => {
    render(
      <ExplorerTxLink chainId={56} txHash={TX_HASH}>
        view tx
      </ExplorerTxLink>,
    );
    expect(screen.getByRole('link', { name: 'view tx' })).toHaveAttribute('href', `https://bscscan.com/tx/${TX_HASH}`);
  });

  it('shows an unknown chain’s hash as plain text instead of linking to the wrong chain', () => {
    // The failure this guards: a cross-chain settlement hash rendered against another chain's
    // explorer resolves to "transaction not found", which reads as a payment that never happened.
    render(
      <ExplorerTxLink chainId={1} txHash={TX_HASH}>
        view tx
      </ExplorerTxLink>,
    );
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('view tx')).toBeInTheDocument();
  });
});
