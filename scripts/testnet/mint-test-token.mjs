import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Contract, JsonRpcProvider, Wallet, getAddress, parseUnits } from 'ethers';

const RPC_URL = 'https://rpc.testnet3.goat.network';
const EXPECTED_CHAIN_ID = 48816n;

const [, , toArg, amountArg] = process.argv;
if (!toArg || !/^0x[a-fA-F0-9]{40}$/.test(toArg)) {
  throw new Error('Usage: node scripts/testnet/mint-test-token.mjs <0xRecipient> [amountInTokens=100]');
}
const to = getAddress(toArg);
const amountTokens = amountArg ?? '100';

const signerPath = resolve('.local/testnet/goat-testnet3-wallet.json');
const deploymentPath = resolve('.local/testnet/shipyard-test-token.json');

const stored = JSON.parse(await readFile(signerPath, 'utf8'));
if (stored.network !== 'goat-testnet3-only' || stored.chainId !== Number(EXPECTED_CHAIN_ID)) {
  throw new Error('Refusing to mint with a signer not explicitly scoped to GOAT Testnet3');
}
const deployment = JSON.parse(await readFile(deploymentPath, 'utf8'));
if (deployment.environment !== 'testnet3' || deployment.chainId !== Number(EXPECTED_CHAIN_ID)) {
  throw new Error('Test token deployment record is not scoped to GOAT Testnet3');
}

const provider = new JsonRpcProvider(RPC_URL, Number(EXPECTED_CHAIN_ID), { staticNetwork: true });
const network = await provider.getNetwork();
if (network.chainId !== EXPECTED_CHAIN_ID) throw new Error(`RPC chain mismatch: ${network.chainId}`);
const wallet = new Wallet(stored.privateKey, provider);
if (wallet.address.toLowerCase() !== String(stored.address).toLowerCase()) {
  throw new Error('Testnet signer address mismatch');
}

const token = new Contract(
  deployment.contractAddress,
  [
    'function mint(address to, uint256 amount) external',
    'function balanceOf(address) view returns (uint256)',
    'function decimals() view returns (uint8)',
  ],
  wallet,
);

const decimals = Number(await token.decimals());
const amountAtomic = parseUnits(amountTokens, decimals);
const tx = await token.mint(to, amountAtomic);
const receipt = await tx.wait(1);
if (receipt?.status !== 1) throw new Error('Mint transaction did not confirm successfully');
const newBalance = await token.balanceOf(to);

process.stdout.write(
  `${JSON.stringify(
    {
      contractAddress: deployment.contractAddress,
      to,
      mintedAtomic: amountAtomic.toString(),
      transactionHash: tx.hash,
      explorerUrl: `https://explorer.testnet3.goat.network/tx/${tx.hash}`,
      newBalanceAtomic: newBalance.toString(),
    },
    null,
    2,
  )}\n`,
);
