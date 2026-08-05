'use client';

import { useState } from 'react';

import { connectWallet, ensureChain, formatWalletError, isWalletAvailable, sendErc20Payment } from '../lib/goat-wallet';

export type PaymentChallenge = Readonly<{
  network: string;
  amount: string;
  asset: string;
  payTo: string;
}>;

export function WalletPayPanel({
  chainId,
  challenge,
  tokenSymbol,
  tokenDecimals,
}: Readonly<{
  chainId: number;
  challenge: PaymentChallenge;
  tokenSymbol?: string;
  tokenDecimals?: number;
}>) {
  const [address, setAddress] = useState<`0x${string}` | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<`0x${string}` | null>(null);

  async function handleConnect() {
    setBusy(true);
    setBusyLabel('Connecting…');
    setError(null);
    try {
      setAddress(await connectWallet());
    } catch (caught) {
      setError(formatWalletError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handlePay() {
    if (!address) return;
    setBusy(true);
    setError(null);
    try {
      setBusyLabel('Switching network…');
      await ensureChain(chainId);
      setBusyLabel('Confirm in wallet…');
      const hash = await sendErc20Payment({
        fromAddress: address,
        tokenAddress: challenge.asset,
        toAddress: challenge.payTo,
        amountAtomic: challenge.amount,
      });
      setTxHash(hash);
    } catch (caught) {
      setError(formatWalletError(caught));
    } finally {
      setBusy(false);
    }
  }

  const amountLabel = tokenDecimals !== undefined ? formatAtomic(challenge.amount, tokenDecimals) : challenge.amount;
  const assetLabel = tokenSymbol ?? shortAddress(challenge.asset);

  return (
    <div className="wallet-pay-panel state-in">
      <dl>
        <div><dt>Amount</dt><dd>{amountLabel} <small>{assetLabel}</small></dd></div>
        <div><dt>Pay to</dt><dd className="mono">{shortAddress(challenge.payTo)}</dd></div>
      </dl>
      {error && (
        <div className="error-card state-in" key={error}>
          <strong>Wallet error</strong>
          <p>{error}</p>
        </div>
      )}
      {txHash ? (
        <div className="wallet-paid state-in">
          <span className="live-pulse" aria-hidden="true" />
          <span>Payment sent</span>
          <a className="explorer-link" href={explorerTxUrl(chainId, txHash)} target="_blank" rel="noreferrer">
            {shortAddress(txHash)} ↗
          </a>
        </div>
      ) : !isWalletAvailable() ? (
        <p className="run-detail-empty">
          No browser wallet detected. Install MetaMask or a compatible extension, or pay {amountLabel} {assetLabel} to{' '}
          <span className="mono">{challenge.payTo}</span> manually.
        </p>
      ) : !address ? (
        <button className="primary-button" type="button" disabled={busy} onClick={handleConnect}>
          {busy && <span className="spinner" aria-hidden="true" />}
          {busy ? busyLabel : 'Connect wallet'}
        </button>
      ) : (
        <button className="primary-button" type="button" disabled={busy} onClick={handlePay}>
          {busy && <span className="spinner" aria-hidden="true" />}
          {busy ? busyLabel : `Pay ${amountLabel} ${assetLabel}`}
        </button>
      )}
    </div>
  );
}

function shortAddress(value: string): string {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function explorerTxUrl(chainId: number, txHash: string): string {
  const base = chainId === 2345 ? 'https://explorer.goat.network' : 'https://explorer.testnet3.goat.network';
  return `${base}/tx/${txHash}`;
}

function formatAtomic(value: string, decimals: number): string {
  if (decimals === 0) return value;
  const divisor = 10n ** BigInt(decimals);
  return `${BigInt(value) / divisor}.${(BigInt(value) % divisor).toString().padStart(decimals, '0')}`;
}
