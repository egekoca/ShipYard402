import { getAddress } from 'viem';
import { z } from 'zod';

export const BNB_MAINNET_CHAIN_ID = 56;
export const BNB_MAINNET_NETWORK = 'eip155:56' as const;
export const BNB_CANONICAL_USDT = '0x55d398326f99059fF775485246999027B3197955' as const;
export const BNB_CANONICAL_USDC = '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d' as const;
export const BNB_SETTLEMENT_ASSETS = { USDT: BNB_CANONICAL_USDT, USDC: BNB_CANONICAL_USDC } as const;
export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as const;
export const X402_EXACT_PERMIT2_PROXY = '0x402085c248EeA27D92E8b30b2C58ed07f9E20001' as const;

const schema = z
  .object({
    BNB_X402_HOST: z.string().min(1).default('127.0.0.1'),
    BNB_X402_PORT: z.string().regex(/^\d+$/).default('3012'),
    BNB_FACILITATOR_HOST: z.literal('127.0.0.1').default('127.0.0.1'),
    BNB_FACILITATOR_PORT: z.string().regex(/^\d+$/).default('3013'),
    BNB_RPC_URL: z.string().url(),
    BNB_FACILITATOR_PRIVATE_KEY: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
    BNB_X402_PAY_TO: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    BNB_X402_SETTLEMENT_ASSET: z.enum(['USDT', 'USDC']).default('USDT'),
    BNB_X402_PRICE_ATOMIC: z
      .string()
      .regex(/^[1-9]\d*$/)
      .default('100000000000000'),
    BNB_X402_MAX_PRICE_ATOMIC: z
      .string()
      .regex(/^[1-9]\d*$/)
      .default('1000000000000000'),
  })
  .strict();

const selectedNames = [
  'BNB_X402_HOST',
  'BNB_X402_PORT',
  'BNB_FACILITATOR_HOST',
  'BNB_FACILITATOR_PORT',
  'BNB_RPC_URL',
  'BNB_FACILITATOR_PRIVATE_KEY',
  'BNB_X402_PAY_TO',
  'BNB_X402_SETTLEMENT_ASSET',
  'BNB_X402_PRICE_ATOMIC',
  'BNB_X402_MAX_PRICE_ATOMIC',
] as const;

export type BnbX402RuntimeConfig = Readonly<{
  targetHost: string;
  targetPort: number;
  facilitatorHost: '127.0.0.1';
  facilitatorPort: number;
  rpcUrl: string;
  facilitatorPrivateKey: `0x${string}`;
  payTo: `0x${string}`;
  /** The ERC-20 this target charges in (canonical BNB USDT or USDC). */
  settlementAsset: `0x${string}`;
  settlementAssetSymbol: 'USDT' | 'USDC';
  priceAtomic: string;
  maxPriceAtomic: string;
}>;

export function parseBnbX402RuntimeConfig(environment: NodeJS.ProcessEnv): BnbX402RuntimeConfig {
  const selected = Object.fromEntries(selectedNames.map((name) => [name, environment[name]]));
  const parsed = schema.safeParse(selected);
  if (!parsed.success) {
    throw new Error(
      `BNB x402 configuration is invalid: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
    );
  }
  const values = parsed.data;
  const targetPort = Number(values.BNB_X402_PORT);
  const facilitatorPort = Number(values.BNB_FACILITATOR_PORT);
  if (targetPort === facilitatorPort) throw new Error('BNB target and facilitator ports must be different');
  if (targetPort < 1 || targetPort > 65_535 || facilitatorPort < 1 || facilitatorPort > 65_535) {
    throw new Error('BNB target and facilitator ports must be between 1 and 65535');
  }
  if (BigInt(values.BNB_X402_PRICE_ATOMIC) > BigInt(values.BNB_X402_MAX_PRICE_ATOMIC)) {
    throw new Error('BNB x402 price exceeds its configured safety ceiling');
  }
  return Object.freeze({
    targetHost: values.BNB_X402_HOST,
    targetPort,
    facilitatorHost: values.BNB_FACILITATOR_HOST,
    facilitatorPort,
    rpcUrl: values.BNB_RPC_URL,
    facilitatorPrivateKey: values.BNB_FACILITATOR_PRIVATE_KEY as `0x${string}`,
    payTo: getAddress(values.BNB_X402_PAY_TO),
    settlementAsset: getAddress(BNB_SETTLEMENT_ASSETS[values.BNB_X402_SETTLEMENT_ASSET]),
    settlementAssetSymbol: values.BNB_X402_SETTLEMENT_ASSET,
    priceAtomic: values.BNB_X402_PRICE_ATOMIC,
    maxPriceAtomic: values.BNB_X402_MAX_PRICE_ATOMIC,
  });
}
