import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Contract, JsonRpcProvider, formatEther, formatUnits, getAddress } from 'ethers';

const RPC_URL = 'https://rpc.testnet3.goat.network';
const EXPECTED_CHAIN_ID = 48816n;
const GOAT_TOKEN = '0xbC10000000000000000000000000000000000001';
const stored = JSON.parse(await readFile(resolve('.local/testnet/goat-testnet3-wallet.json'), 'utf8'));
if (stored.network !== 'goat-testnet3-only' || stored.chainId !== Number(EXPECTED_CHAIN_ID)) {
  throw new Error('Refusing to use a signer file not explicitly scoped to GOAT Testnet3');
}
const address = getAddress(stored.address);
const provider = new JsonRpcProvider(RPC_URL, Number(EXPECTED_CHAIN_ID), { staticNetwork: true });
const network = await provider.getNetwork();
if (network.chainId !== EXPECTED_CHAIN_ID) {
  throw new Error(`GOAT Testnet3 RPC chain mismatch: ${network.chainId}`);
}

const nativeBalance = await provider.getBalance(address);
const token = new Contract(GOAT_TOKEN, [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
], provider);
let goatToken = { available: false };
try {
  const [symbol, decimals, balance] = await Promise.all([
    token.symbol(), token.decimals(), token.balanceOf(address),
  ]);
  goatToken = {
    available: true,
    address: GOAT_TOKEN,
    symbol,
    decimals: Number(decimals),
    balanceAtomic: balance.toString(),
    balance: formatUnits(balance, decimals),
  };
} catch {
  goatToken = { available: false, address: GOAT_TOKEN };
}

process.stdout.write(JSON.stringify({
  network: 'goat-testnet3',
  chainId: Number(network.chainId),
  rpcUrl: RPC_URL,
  address,
  nativeGas: {
    symbol: 'BTC',
    balanceWei: nativeBalance.toString(),
    balance: formatEther(nativeBalance),
  },
  goatToken,
}, null, 2) + '\n');
