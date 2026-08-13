export const BNB_MAINNET_CHAIN_ID = 56;
export const BNB_MAINNET_NETWORK = 'eip155:56' as const;
export const BNB_CANONICAL_USDT = '0x55d398326f99059fF775485246999027B3197955' as const;
export const BNB_USDT_DECIMALS = 18;
export const BNB_CANONICAL_USDC = '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d' as const;
export const BNB_USDC_DECIMALS = 18;
/**
 * World Liberty Financial USD. Included because it is, as of 2026-08, the only BNB Chain asset in
 * the live x402 directory that both supports EIP-3009 and is priced by a real third-party service
 * -- canonical USDT and USDC are plain ERC-20s, so services quoting those use Permit2 variants.
 */
export const BNB_USD1 = '0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d' as const;
export const BNB_USD1_DECIMALS = 18;
export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as const;
export const X402_EXACT_PERMIT2_PROXY = '0x402085c248EeA27D92E8b30b2C58ed07f9E20001' as const;

/**
 * Per-asset facts that must never be inferred. BNB Chain's USDT and USDC are 18-decimal, unlike
 * the 6-decimal versions on most other chains, and canonical BNB USDT has no EIP-3009 support at
 * all -- a payer that guesses either one signs for the wrong number or an unsignable method.
 */
export type BnbAssetInfo = Readonly<{
  address: `0x${string}`;
  symbol: string;
  decimals: number;
  supportsEip3009: boolean;
}>;

/**
 * Every flag here was read off BNB mainnet, not assumed: USDT and USDC expose neither
 * `DOMAIN_SEPARATOR` nor `authorizationState`, while USD1 exposes both.
 */
export const BNB_ASSETS: readonly BnbAssetInfo[] = Object.freeze([
  Object.freeze({ address: BNB_CANONICAL_USDT, symbol: 'USDT', decimals: BNB_USDT_DECIMALS, supportsEip3009: false }),
  Object.freeze({ address: BNB_CANONICAL_USDC, symbol: 'USDC', decimals: BNB_USDC_DECIMALS, supportsEip3009: false }),
  Object.freeze({ address: BNB_USD1, symbol: 'USD1', decimals: BNB_USD1_DECIMALS, supportsEip3009: true }),
]);

/** Looks up a known BNB settlement asset, or null when this build has no facts about it. */
export function bnbAssetInfo(address: string): BnbAssetInfo | null {
  const needle = address.toLowerCase();
  return BNB_ASSETS.find((asset) => asset.address.toLowerCase() === needle) ?? null;
}
