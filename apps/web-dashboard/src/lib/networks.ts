/**
 * Single source of truth for the blockchain networks Shipyard402 works across, and -- crucially --
 * how far each one actually is. The `status` is deliberately honest: only GOAT Testnet3 has a real
 * run history today, cross-chain BNB settlement is implemented but not yet proven with a mainnet
 * run, and BOT Chain is still scaffolding. The UI renders these badges verbatim so marketing copy
 * can never quietly overclaim a network as production-live before it is.
 */

export type NetworkStatus = 'live' | 'beta' | 'coming';

export type NetworkRole =
  | 'settlement' // a chain a run is priced and paid on
  | 'bridge-source' // funds start here, get bridged out
  | 'bridge-destination'; // bridged funds land here to pay a target

export type NetworkInfo = Readonly<{
  id: string;
  name: string;
  /** Compact label for pills/chips, e.g. "GOAT T3". */
  shortLabel: string;
  chainId: number;
  /** CSS custom property holding this network's brand color (defined in styles.css). */
  colorVar: string;
  /** Real brand logo under /public, and the background its artwork sits on (so the tile matches). */
  logo: Readonly<{ src: string; background: string }>;
  /** Block explorer origin, used to build transaction links. No trailing slash. */
  explorerUrl: string;
  status: NetworkStatus;
  roles: readonly NetworkRole[];
  /** One-line, truthful description of what this network is used for today. */
  blurb: string;
}>;

export const NETWORK_STATUS_LABEL: Readonly<Record<NetworkStatus, string>> = {
  live: 'Live',
  beta: 'Beta',
  coming: 'Coming',
};

export const GOAT_TESTNET3: NetworkInfo = {
  id: 'goat-testnet3',
  name: 'GOAT Testnet3',
  shortLabel: 'GOAT T3',
  chainId: 48816,
  colorVar: '--goat',
  logo: { src: '/networks/goat.jpeg', background: '#ffffff' },
  explorerUrl: 'https://explorer.testnet3.goat.network',
  status: 'live',
  roles: ['settlement'],
  blurb: 'Where real runs execute today: paid x402 procurement, adversarial checks, and signed on-chain attestation.',
};

export const GOAT_MAINNET: NetworkInfo = {
  id: 'goat-mainnet',
  name: 'GOAT Network',
  shortLabel: 'GOAT',
  chainId: 2345,
  colorVar: '--goat',
  logo: { src: '/networks/goat.jpeg', background: '#ffffff' },
  explorerUrl: 'https://explorer.goat.network',
  status: 'beta',
  roles: ['settlement', 'bridge-source'],
  blurb: 'Mainnet settlement, and where cross-chain runs start.',
};

export const BNB_CHAIN: NetworkInfo = {
  id: 'bnb',
  name: 'BNB Chain',
  shortLabel: 'BNB',
  chainId: 56,
  colorVar: '--bnb',
  logo: { src: '/networks/bnb.png', background: '#0b0c0e' },
  explorerUrl: 'https://bscscan.com',
  status: 'beta',
  roles: ['bridge-destination', 'settlement'],
  blurb: 'Pay a BNB x402 target from GOAT funds — bridged over Stargate.',
};

export const BOT_CHAIN: NetworkInfo = {
  id: 'bot-chain',
  name: 'BOT Chain',
  shortLabel: 'BOT Chain',
  chainId: 968,
  colorVar: '--bot-green',
  logo: { src: '/networks/botchain.jpeg', background: '#050607' },
  explorerUrl: 'https://scan.bohr.life',
  status: 'coming',
  roles: ['settlement'],
  blurb: 'Direct-merchant settlement. Adapter ready, registry next.',
};

export const BOT_CHAIN_MAINNET: NetworkInfo = {
  id: 'bot-chain-mainnet',
  name: 'BOT Chain',
  shortLabel: 'BOT',
  chainId: 677,
  colorVar: '--bot-green',
  logo: { src: '/networks/botchain.jpeg', background: '#050607' },
  explorerUrl: 'https://scan.botchain.ai',
  status: 'coming',
  roles: ['settlement'],
  blurb: 'Direct-merchant settlement on BOT mainnet. Not yet exercised.',
};

/** The networks the marketing surface presents, in the order they should appear. */
export const SHOWCASE_NETWORKS: readonly NetworkInfo[] = [GOAT_MAINNET, BNB_CHAIN, BOT_CHAIN];

/**
 * Every network this codebase can name, showcased or not. Anything that needs to turn a chain ID
 * into a human-facing fact -- an explorer link, a label, a logo -- resolves it from here rather
 * than keeping its own map, so a chain can never be half-known: present in one component's table
 * and missing from another's.
 */
export const ALL_NETWORKS: readonly NetworkInfo[] = [
  GOAT_MAINNET,
  GOAT_TESTNET3,
  BNB_CHAIN,
  BOT_CHAIN_MAINNET,
  BOT_CHAIN,
];

const NETWORK_BY_CHAIN_ID: ReadonlyMap<number, NetworkInfo> = new Map(
  ALL_NETWORKS.map((network) => [network.chainId, network]),
);

/** Resolves a chain ID to its network identity, or null when this build does not know that chain. */
export function networkByChainId(chainId: number): NetworkInfo | null {
  return NETWORK_BY_CHAIN_ID.get(chainId) ?? null;
}

/**
 * Builds an explorer link for a transaction, or returns null when this build has no identity for
 * that chain. There is deliberately no fallback explorer: guessing sends the reader to a different
 * chain's explorer, where the hash simply does not exist, which reads as "this payment never
 * happened". Rendering the hash as plain text is the honest failure.
 */
export function explorerTxUrl(chainId: number, txHash: string): string | null {
  const network = networkByChainId(chainId);
  return network ? `${network.explorerUrl}/tx/${txHash}` : null;
}
