import { toFacilitatorEvmSigner } from '@x402/evm';
import { createPublicClient, createWalletClient, defineChain, http, publicActions } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { createControlledBnbFacilitatorApp, createControlledBnbTargetApp } from './apps.js';
import { BNB_MAINNET_CHAIN_ID, parseBnbX402RuntimeConfig } from './runtime-config.js';

const config = parseBnbX402RuntimeConfig(process.env);
const account = privateKeyToAccount(config.facilitatorPrivateKey);
const bnbChain = defineChain({
  id: BNB_MAINNET_CHAIN_ID,
  name: 'BNB Smart Chain',
  nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
  rpcUrls: { default: { http: [config.rpcUrl] } },
  blockExplorers: { default: { name: 'BscScan', url: 'https://bscscan.com' } },
});
const transport = http(config.rpcUrl);
const publicClient = createPublicClient({ chain: bnbChain, transport });
const walletClient = createWalletClient({ account, chain: bnbChain, transport }).extend(publicActions);
const signer = toFacilitatorEvmSigner({
  address: account.address,
  readContract: (args) => walletClient.readContract({ ...args, args: args.args ?? [] } as never),
  verifyTypedData: (args) => publicClient.verifyTypedData(args as never),
  writeContract: (args) => walletClient.writeContract({ ...args, account, chain: bnbChain } as never),
  sendTransaction: (args) => walletClient.sendTransaction({ ...args, account, chain: bnbChain }),
  waitForTransactionReceipt: (args) => publicClient.waitForTransactionReceipt(args),
  getCode: (args) => publicClient.getCode(args),
});

const facilitatorApp = createControlledBnbFacilitatorApp(config, signer);
const targetApp = createControlledBnbTargetApp(config);

await facilitatorApp.listen({ host: config.facilitatorHost, port: config.facilitatorPort });
try {
  await targetApp.listen({ host: config.targetHost, port: config.targetPort });
} catch (error) {
  await facilitatorApp.close();
  throw error;
}

process.stdout.write(
  `Controlled BNB x402 v2 target listening on ${config.targetHost}:${config.targetPort}; facilitator ${config.facilitatorHost}:${config.facilitatorPort}; signer ${account.address}\n`,
);

async function shutdown(signal: string): Promise<void> {
  process.stdout.write(`Received ${signal}; stopping controlled BNB x402 services\n`);
  await Promise.all([targetApp.close(), facilitatorApp.close()]);
  process.exit(0);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
