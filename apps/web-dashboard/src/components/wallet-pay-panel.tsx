'use client';

import { useEffect, useState } from 'react';

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
  connectedAddress,
}: Readonly<{
  chainId: number;
  challenge: PaymentChallenge;
  tokenSymbol?: string;
  tokenDecimals?: number;
  /** Already-connected address, if the wallet was connected elsewhere (e.g. earlier in the form) -- skips asking to connect again. */
  connectedAddress?: `0x${string}` | null;
}>) {
  const [address, setAddress] = useState<`0x${string}` | null>(connectedAddress ?? null);
  const [networkStatus, setNetworkStatus] = useState<'checking' | 'ready' | 'failed'>('checking');
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<`0x${string}` | null>(null);

  useEffect(() => {
    if (connectedAddress) setAddress(connectedAddress);
  }, [connectedAddress]);

  // As soon as an address is known, add/switch to the right GOAT chain automatically -- no click
  // required, so by the time the customer presses Pay the wallet is already on the right network.
  // A failure here (e.g. the add-network prompt was dismissed) still leaves Pay clickable below;
  // handlePay retries the same ensureChain call, so nothing gets permanently stuck.
  useEffect(() => {
    if (!address || !isWalletAvailable()) return;
    let cancelled = false;
    setNetworkStatus('checking');
    ensureChain(chainId)
      .then(() => { if (!cancelled) setNetworkStatus('ready'); })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setNetworkStatus('failed');
        setError(formatWalletError(caught));
      });
    return () => { cancelled = true; };
  }, [address, chainId]);

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
        <button className="primary-button" type="button" disabled={busy || networkStatus === 'checking'} onClick={handlePay}>
          {(busy || networkStatus === 'checking') && <span className="spinner" aria-hidden="true" />}
          {busy ? busyLabel : networkStatus === 'checking' ? 'Adding GOAT network…' : `Pay ${amountLabel} ${assetLabel}`}
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
