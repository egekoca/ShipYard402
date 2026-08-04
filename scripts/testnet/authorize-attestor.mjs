import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Contract, JsonRpcProvider, Wallet } from 'ethers';

const RPC_URL = 'https://rpc.testnet3.goat.network';
const EXPECTED_CHAIN_ID = 48816n;
const signerPath = resolve('.local/testnet/goat-testnet3-wallet.json');
const deploymentPath = resolve('.local/testnet/shipyard-run-registry.json');
const authorizationPath = resolve('.local/testnet/shipyard-run-registry-attestor.json');
const abiPath = resolve('contracts/out-solc/src_ShipyardRunRegistry_sol_ShipyardRunRegistry.abi');

const existing = await loadExistingAuthorization();
if (existing) {
  process.stdout.write(JSON.stringify({ ...existing, reused: true }, null, 2) + '\n');
  process.exit(0);
}

const stored = JSON.parse(await readFile(signerPath, 'utf8'));
if (stored.network !== 'goat-testnet3-only' || stored.chainId !== Number(EXPECTED_CHAIN_ID)) {
  throw new Error('Refusing to authorize an attestor with a signer not explicitly scoped to GOAT Testnet3');
}
const deployment = JSON.parse(await readFile(deploymentPath, 'utf8'));
if (deployment.environment !== 'testnet3' || deployment.chainId !== Number(EXPECTED_CHAIN_ID)) {
  throw new Error('Registry deployment record is not scoped to GOAT Testnet3');
}

const provider = new JsonRpcProvider(RPC_URL, Number(EXPECTED_CHAIN_ID), { staticNetwork: true });
const network = await provider.getNetwork();
if (network.chainId !== EXPECTED_CHAIN_ID) throw new Error(`RPC chain mismatch: ${network.chainId}`);
const wallet = new Wallet(stored.privateKey, provider);
if (wallet.address.toLowerCase() !== String(stored.address).toLowerCase()) {
  throw new Error('Testnet signer address mismatch');
}

const abi = JSON.parse(await readFile(abiPath, 'utf8'));
const registry = new Contract(deployment.contractAddress, abi, wallet);
const owner = await registry.owner();
if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
  throw new Error('Only the registry owner can authorize an attestor');
}
const alreadyAuthorized = await registry.authorizedAttestors(wallet.address);
if (alreadyAuthorized) {
  const result = {
    registryAddress: deployment.contractAddress,
    attestor: wallet.address,
    transactionHash: null,
    note: 'Attestor was already authorized on-chain; no transaction was needed.',
  };
  await writeFile(authorizationPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  process.stdout.write(JSON.stringify({ ...result, reused: false }, null, 2) + '\n');
  process.exit(0);
}

const tx = await registry.setAttestor(wallet.address, true);
const receipt = await tx.wait(1);
if (!receipt || receipt.status !== 1) {
  throw new Error('setAttestor transaction did not confirm successfully');
}
const confirmedAuthorized = await registry.authorizedAttestors(wallet.address);
if (!confirmedAuthorized) throw new Error('setAttestor succeeded but the attestor is not marked authorized');

const result = {
  registryAddress: deployment.contractAddress,
  attestor: wallet.address,
  transactionHash: tx.hash,
  blockNumber: receipt.blockNumber,
};
await writeFile(authorizationPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
process.stdout.write(JSON.stringify({ ...result, reused: false }, null, 2) + '\n');

async function loadExistingAuthorization() {
  try {
    return JSON.parse(await readFile(authorizationPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}
