'use client';

import { useEffect, useState } from 'react';

import { createApiClient, DEFAULT_API_BACKEND, type ApiBackendId } from '../lib/api-backends';
import { formatAtomic } from '../lib/amount-format';
import {
  connectWallet,
  ensureChain,
  formatWalletError,
  isWalletAvailable,
  readErc20Balance,
  sendErc20Payment,
} from '../lib/goat-wallet';
import { getStoredSessionToken } from '../lib/session';
import { ExplorerTxLink } from './explorer-tx-link';

export type PaymentChallenge = Readonly<{
  network: string;
  amount: string;
  asset: string;
  payTo: string;
}>;

export function WalletPayPanel({
  runId,
  chainId,
  challenge,
  tokenSymbol,
  tokenDecimals,
  connectedAddress,
  apiBackend = DEFAULT_API_BACKEND,
}: Readonly<{
  runId: string;
  chainId: number;
  challenge: PaymentChallenge;
  tokenSymbol?: string | undefined;
  tokenDecimals?: number | undefined;
  /** Already-connected address, if the wallet was connected elsewhere (e.g. earlier in the form) -- skips asking to connect again. */
  connectedAddress?: `0x${string}` | null | undefined;
  apiBackend?: ApiBackendId | undefined;
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
      .then(() => {
        if (!cancelled) setNetworkStatus('ready');
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setNetworkStatus('failed');
        setError(formatWalletError(caught));
      });
    return () => {
      cancelled = true;
    };
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
      setBusyLabel('Checking balance…');
      const balanceAtomic = await readErc20Balance(challenge.asset, address);
      if (balanceAtomic < BigInt(challenge.amount)) {
        const needed = tokenDecimals !== undefined ? formatAtomic(challenge.amount, tokenDecimals) : challenge.amount;
        const available =
          tokenDecimals !== undefined ? formatAtomic(balanceAtomic.toString(), tokenDecimals) : balanceAtomic;
        throw new Error(`Insufficient ${assetLabel} balance. Need ${needed}; wallet has ${available}.`);
      }
      setBusyLabel('Confirm in wallet…');
      const hash = await sendErc20Payment({
        fromAddress: address,
        tokenAddress: challenge.asset,
        toAddress: challenge.payTo,
        amountAtomic: challenge.amount,
      });
      setTxHash(hash);
      // Best-effort: only a BOT-Chain-configured backend needs this (no merchant/order API to
      // discover the payment on its own -- see submitPaymentTransaction's own doc comment). A
      // GOAT Flow deployment responds 503, which is expected and fine here, not a real failure --
      // the payment already succeeded on-chain regardless of whether this call does anything.
      void createApiClient(apiBackend, () => getStoredSessionToken(address, apiBackend))
        .submitPaymentTransaction(runId, hash)
        .catch(() => {});
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
        <div>
          <dt>Amount</dt>
          <dd>
            {amountLabel} <small>{assetLabel}</small>
          </dd>
        </div>
        <div>
          <dt>Pay to</dt>
          <dd className="mono">{shortAddress(challenge.payTo)}</dd>
        </div>
        {txHash && (
          <div>
            <dt>Transaction</dt>
            <dd>
              <ExplorerTxLink chainId={chainId} txHash={txHash}>
                {shortAddress(txHash)} ↗
              </ExplorerTxLink>
            </dd>
          </div>
        )}
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
          <span>Payment sent — confirming on-chain</span>
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
        <button
          className="primary-button"
          type="button"
          disabled={busy || networkStatus === 'checking'}
          onClick={handlePay}
        >
          {(busy || networkStatus === 'checking') && <span className="spinner" aria-hidden="true" />}
          {busy ? busyLabel : networkStatus === 'checking' ? 'Switching network…' : `Pay ${amountLabel} ${assetLabel}`}
        </button>
      )}
    </div>
  );
}

function shortAddress(value: string): string {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}
