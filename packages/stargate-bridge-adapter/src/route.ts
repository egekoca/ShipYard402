import {
  BNB_CHAIN_MAINNET_NETWORK,
  GOAT_MAINNET_NETWORK,
  type EvmAddress,
  type EvmAsset,
} from '@shipyard402/x402-payments';

export type StargateRoute = Readonly<{
  id: string;
  sourceAsset: EvmAsset;
  sourceOftAddress: EvmAddress;
  sourceEndpointId: number;
  sharedDecimals: number;
  destinationAsset: EvmAsset;
  destinationOftAddress: EvmAddress;
  destinationEndpointId: number;
}>;

/**
 * Official Stargate V2 mainnet deployments. GOAT's USDT pool delivers canonical BNB Chain USDT,
 * so this route does not need a destination swap.
 */
export const GOAT_TO_BNB_USDT_STARGATE_ROUTE = Object.freeze({
  id: 'stargate-v2:goat-mainnet-usdt:bnb-mainnet-usdt',
  sourceAsset: {
    network: GOAT_MAINNET_NETWORK,
    tokenAddress: '0xE1AD845D93853fff44990aE0DcecD8575293681e',
    symbol: 'USDT',
    decimals: 6,
  },
  sourceOftAddress: '0x549943e04f40284185054145c6E4e9568C1D3241',
  sourceEndpointId: 30361,
  sharedDecimals: 6,
  destinationAsset: {
    network: BNB_CHAIN_MAINNET_NETWORK,
    tokenAddress: '0x55d398326f99059fF775485246999027B3197955',
    symbol: 'USDT',
    decimals: 18,
  },
  destinationOftAddress: '0x138EB30f73BC423c6455C53df6D89CB01d9eBc63',
  destinationEndpointId: 30102,
} satisfies StargateRoute);

/**
 * GOAT USDC -> BNB Chain USDC via Stargate V2. Lets a run funded in GOAT USDC pay a BNB x402 target
 * without first swapping to USDT. All four contract addresses and both endpoint IDs were taken from
 * Stargate's official V2 mainnet-contracts reference and then verified on-chain: each pool's live
 * `token()` returns the USDC address below and `sharedDecimals()` is 6. GOAT's `StargatePoolUSDT`
 * address on that same reference matches this file's USDT route, which is how the source was trusted.
 */
export const GOAT_TO_BNB_USDC_STARGATE_ROUTE = Object.freeze({
  id: 'stargate-v2:goat-mainnet-usdc:bnb-mainnet-usdc',
  sourceAsset: {
    network: GOAT_MAINNET_NETWORK,
    tokenAddress: '0x3022b87ac063DE95b1570F46f5e470F8B53112D8',
    symbol: 'USDC',
    decimals: 6,
  },
  sourceOftAddress: '0xbbA60da06c2c5424f03f7434542280FCAd453d10',
  sourceEndpointId: 30361,
  sharedDecimals: 6,
  destinationAsset: {
    network: BNB_CHAIN_MAINNET_NETWORK,
    tokenAddress: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    symbol: 'USDC',
    decimals: 18,
  },
  destinationOftAddress: '0x962Bd449E630b0d928f308Ce63f1A21F02576057',
  destinationEndpointId: 30102,
} satisfies StargateRoute);

/** Every GOAT -> BNB Stargate route this adapter knows, keyed by the source asset symbol. */
export const GOAT_TO_BNB_STARGATE_ROUTES = Object.freeze({
  USDT: GOAT_TO_BNB_USDT_STARGATE_ROUTE,
  USDC: GOAT_TO_BNB_USDC_STARGATE_ROUTE,
} satisfies Record<string, StargateRoute>);

export type GoatToBnbRouteAsset = keyof typeof GOAT_TO_BNB_STARGATE_ROUTES;

/**
 * Resolves the route for a source asset symbol, failing loudly on an unsupported one. A typo or an
 * asset with no Stargate pool must not silently fall back to a different token's route -- that would
 * bridge the wrong asset -- so this throws rather than defaulting.
 */
export function goatToBnbStargateRoute(sourceSymbol: string): StargateRoute {
  const route = (GOAT_TO_BNB_STARGATE_ROUTES as Record<string, StargateRoute>)[sourceSymbol];
  if (!route) {
    throw new Error(`No GOAT->BNB Stargate route for source asset "${sourceSymbol}"`);
  }
  return route;
}
