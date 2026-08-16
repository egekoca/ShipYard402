import type { CSSProperties } from 'react';

import { SHOWCASE_NETWORKS, type NetworkInfo } from '../lib/networks';

/**
 * Renders a network's real brand logo as a rounded tile. The tile background is taken from each
 * logo's own artwork (GOAT is black-on-white, BOT Chain is green-on-black, BNB is a yellow disc), so
 * every mark reads correctly on the dark UI without recoloring third-party artwork. Files live under
 * /public/networks and are plain static assets — no next/image loader needed at these sizes.
 */

const BY_ID: Readonly<Record<string, NetworkInfo>> = Object.fromEntries(
  SHOWCASE_NETWORKS.map((network) => [network.id, network]),
);

// GOAT testnet3 shares the GOAT mainnet artwork; alias any goat* id to it.
const GOAT = SHOWCASE_NETWORKS.find((network) => network.id === 'goat-mainnet');

function resolveNetwork(networkId: string): NetworkInfo | undefined {
  if (networkId.startsWith('goat')) return GOAT;
  return BY_ID[networkId];
}

export function NetworkLogo({
  networkId,
  size = 26,
  className,
}: Readonly<{ networkId: string; size?: number; className?: string }>) {
  const network = resolveNetwork(networkId);
  if (!network) return null;
  return (
    <span
      className={className ? `network-logo ${className}` : 'network-logo'}
      style={{ '--logo-bg': network.logo.background, width: size, height: size } as CSSProperties}
    >
      {/* biome-ignore lint/performance/noImgElement: small static brand asset; next/image adds no value here */}
      <img src={network.logo.src} alt="" className="network-logo-img" width={size} height={size} loading="lazy" />
    </span>
  );
}
