import { z } from 'zod';

export const GOAT_MAINNET = Object.freeze({
  chainId: 2345,
  chainIdHex: '0x929',
  name: 'GOAT Network',
  nativeCurrency: Object.freeze({ name: 'Bitcoin', symbol: 'BTC', decimals: 18 }),
  publicRpcUrl: 'https://rpc.goat.network',
  backupRpcUrl: 'https://rpc.ankr.com/goat_mainnet',
  explorerUrl: 'https://explorer.goat.network',
  flowApiUrl: 'https://flow-api.goat.network',
  flowMerchantUrl: 'https://flow-merchant.goat.network',
  flowQuickPayUrl: 'https://flow-quickpay.goat.network',
});

export const GOAT_TESTNET3 = Object.freeze({
  chainId: 48816,
  chainIdHex: '0xbeb0',
  name: 'GOAT Testnet3',
  nativeCurrency: Object.freeze({ name: 'Bitcoin', symbol: 'BTC', decimals: 18 }),
  publicRpcUrl: 'https://rpc.testnet3.goat.network',
  explorerUrl: 'https://explorer.testnet3.goat.network',
  flowApiUrl: 'https://flow-api.testnet3.goat.network',
  flowMerchantUrl: 'https://flow-merchant.testnet3.goat.network',
  flowQuickPayUrl: 'https://flow-quickpay.testnet3.goat.network',
});

export const flowRuntimeCapabilitySchema = z
  .object({
    environment: z.enum(['mainnet', 'testnet3']),
    merchantId: z.string().min(1),
    mode: z.literal('ERC20_DIRECT'),
    chainId: z.number().int().positive(),
    tokenAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    tokenSymbol: z.string().min(1).max(32),
    tokenDecimals: z.number().int().min(0).max(36),
    receivingAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    minimumAtomicAmount: z.string().regex(/^(0|[1-9]\d*)$/),
    maximumAtomicAmount: z.string().regex(/^(0|[1-9]\d*)$/),
    discoveredAt: z.string().datetime(),
    source: z.enum(['AUTHENTICATED_API', 'CHALLENGE', 'QUICKPAY_MANIFEST', 'PORTAL_REVIEW']),
  })
  .strict()
  .superRefine((capability, context) => {
    if (BigInt(capability.minimumAtomicAmount) > BigInt(capability.maximumAtomicAmount)) {
      context.addIssue({
        code: 'custom',
        path: ['minimumAtomicAmount'],
        message: 'Minimum amount cannot exceed maximum amount',
      });
    }
    const expectedChain = capability.environment === 'mainnet' ? GOAT_MAINNET.chainId : GOAT_TESTNET3.chainId;
    if (capability.chainId !== expectedChain) {
      context.addIssue({
        code: 'custom',
        path: ['chainId'],
        message: `Chain does not match ${capability.environment}`,
      });
    }
  });

export type FlowRuntimeCapability = z.infer<typeof flowRuntimeCapabilitySchema>;
