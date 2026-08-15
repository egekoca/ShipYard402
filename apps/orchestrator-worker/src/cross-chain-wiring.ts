import {
  bnbAssetInfo,
  BNB_MAINNET_CHAIN_ID,
  BNB_MAINNET_NETWORK,
  BnbX402PaymentClient,
  createOfficialBnbX402PaidRequestPort,
  createViemBnbPermit2AllowancePort,
} from '@shipyard402/bnb-x402-client';
import type { createShipyardPool } from '@shipyard402/persistence-postgres';
import { PostgresBnbPurchaseStore, PostgresBridgeSubmissionStore } from '@shipyard402/persistence-postgres';
import {
  EthersDestinationReceiptPort,
  EthersStargateSourceChainPort,
  goatToBnbStargateRoute,
  LayerZeroScanClient,
  STARGATE_V2_PROVIDER,
  StargateBridgeAdapter,
} from '@shipyard402/stargate-bridge-adapter';
import type { EvmAsset } from '@shipyard402/x402-payments';
import { getAddress, JsonRpcProvider, Wallet } from 'ethers';

import type { CrossChainPayerRegistration } from './pipeline/types.js';
import type { OrchestratorWorkerRuntimeConfig } from './runtime-config.js';

type CrossChainConfig = NonNullable<OrchestratorWorkerRuntimeConfig['crossChain']>;

/**
 * Assembles cross-chain procurement from config, isolated from main.ts so the entry point stays a
 * wiring list. Returns undefined when cross-chain is not configured, so the caller can spread it
 * straight into the pipeline dependencies.
 *
 * Both modes end up paying through the same client and the same policy; they differ only in how
 * the destination payer got its balance. BRIDGE_THEN_PAY derives the settlement asset from the
 * Stargate route, so the payer can only ever spend what that route actually delivers, while
 * PREFUNDED takes it from config because there is no route to derive it from.
 */
export async function buildCrossChainProcurement(input: {
  crossChain: CrossChainConfig;
  pool: ReturnType<typeof createShipyardPool>;
  signerWallet: Wallet;
}): Promise<readonly CrossChainPayerRegistration[]> {
  const { crossChain, pool, signerWallet } = input;

  const bnbProvider = new JsonRpcProvider(crossChain.bnbRpcUrl, BNB_MAINNET_CHAIN_ID, { staticNetwork: true });
  const bnbNetwork = await bnbProvider.getNetwork();
  if (bnbNetwork.chainId !== BigInt(BNB_MAINNET_CHAIN_ID)) {
    throw new Error(`BNB RPC chain mismatch: ${bnbNetwork.chainId}`);
  }

  const destinationPayerAddress = new Wallet(crossChain.bnbPayerPrivateKey).address as `0x${string}`;
  const bridgeRoute = crossChain.bridge ? goatToBnbStargateRoute(crossChain.bridge.sourceAssetSymbol) : undefined;
  // One settlement asset, whichever mode: the payer's policy, the bridge intent and the ceiling all
  // read from this, so there is no second place for them to disagree.
  const settlementAsset: EvmAsset = bridgeRoute
    ? bridgeRoute.destinationAsset
    : describeAsset(crossChain.settlementAsset as `0x${string}`);

  const allowance = createViemBnbPermit2AllowancePort({
    rpcUrl: crossChain.bnbRpcUrl,
    payerPrivateKey: crossChain.bnbPayerPrivateKey,
    maxApprovalGasCostWei: crossChain.maxApprovalGasCostWei,
  });
  return [
    {
      chainId: BNB_MAINNET_CHAIN_ID,
      mode: crossChain.mode,
      policyCostAtomic: crossChain.policyCostAtomic,
      targetPaymentAmountAtomic: crossChain.targetPaymentAmountAtomic,
      settlementAsset,
      destinationPayerAddress,
      ...(crossChain.targetPayToAddress ? { targetPayToAddress: crossChain.targetPayToAddress } : {}),
      // Built per run against whichever directory service the customer picked. Only the limits are
      // fixed in advance; the endpoint, and everything the target charges, are not.
      payerFor: (endpoint: string) =>
        new BnbX402PaymentClient({
          maximumAtomicAmount: crossChain.targetPaymentAmountAtomic,
          allowance,
          paidRequest: createOfficialBnbX402PaidRequestPort({
            rpcUrl: crossChain.bnbRpcUrl,
            payerPrivateKey: crossChain.bnbPayerPrivateKey,
            endpoint,
            policy: {
              network: BNB_MAINNET_NETWORK,
              allowedAssets: [settlementAsset.tokenAddress],
              maximumAtomicAmount: crossChain.targetPaymentAmountAtomic,
              ...(crossChain.targetPayToAddress ? { payTo: crossChain.targetPayToAddress } : {}),
            },
          }),
          store: new PostgresBnbPurchaseStore(pool),
        }),
      ...(crossChain.bridge && bridgeRoute
        ? {
            bridge: {
              provider: STARGATE_V2_PROVIDER,
              fundingAsset: bridgeRoute.sourceAsset,
              sourceBridgeAmountAtomic: crossChain.bridge.sourceBridgeAmountAtomic,
              sourceBridgePayerAddress: signerWallet.address as `0x${string}`,
              maximumBridgeWaitSeconds: crossChain.bridge.maximumBridgeWaitSeconds,
              port: new StargateBridgeAdapter({
                route: bridgeRoute,
                sourceChain: new EthersStargateSourceChainPort({ signer: signerWallet }),
                layerZeroScan: new LayerZeroScanClient({
                  sourceEndpointId: bridgeRoute.sourceEndpointId,
                  destinationEndpointId: bridgeRoute.destinationEndpointId,
                  baseUrl: crossChain.bridge.layerZeroScanApiUrl,
                }),
                destinationReceipts: new EthersDestinationReceiptPort({ provider: bnbProvider }),
                submissionStore: new PostgresBridgeSubmissionStore(pool),
                maxNativeFeeWei: crossChain.bridge.maxNativeFeeWei,
              }),
            },
          }
        : {}),
    },
  ];
}

/**
 * Describes a configured settlement asset. A known asset carries its real symbol and decimals from
 * the on-chain-verified registry; an unknown one stays usable but is labelled as such rather than
 * given invented metadata, because guessing decimals is how a payment becomes orders of magnitude
 * larger than intended.
 */
function describeAsset(tokenAddress: `0x${string}`): EvmAsset {
  const address = getAddress(tokenAddress) as `0x${string}`;
  const known = bnbAssetInfo(address);
  return {
    network: BNB_MAINNET_NETWORK,
    tokenAddress: address,
    symbol: known?.symbol ?? 'UNKNOWN',
    decimals: known?.decimals ?? 18,
  };
}
