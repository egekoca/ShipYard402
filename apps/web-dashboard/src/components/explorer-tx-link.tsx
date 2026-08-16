'use client';

import type { ReactNode } from 'react';

import { explorerTxUrl } from '../lib/networks';

/**
 * A transaction hash rendered as an explorer link when the chain is known, and as plain text when
 * it is not. Every transaction the dashboard shows goes through here so that adding a chain to
 * `lib/networks` is the only thing needed to make its hashes clickable everywhere at once.
 */
export function ExplorerTxLink({
  chainId,
  txHash,
  children,
}: Readonly<{ chainId: number; txHash: string; children: ReactNode }>) {
  const href = explorerTxUrl(chainId, txHash);
  if (!href) {
    return (
      <span className="explorer-link explorer-link--unresolved" title={`No known explorer for chain ${chainId}`}>
        {children}
      </span>
    );
  }
  return (
    <a className="explorer-link" href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}
