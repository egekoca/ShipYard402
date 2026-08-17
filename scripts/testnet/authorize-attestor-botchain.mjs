import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Contract, JsonRpcProvider, Wallet } from 'ethers';

const RPC_URL = 'https://rpc.bohr.life';
const EXPECTED_CHAIN_ID = 968n;
const signerPath = resolve('.local/testnet/botchain-testnet-wallet.json');
const deploymentPath = resolve('.local/testnet/shipyard-run-registry-botchain.json');
const authorizationPath = resolve('.local/testnet/shipyard-run-registry-attestor-botchain.json');
const abiPath = resolve('contracts/out-solc/src_ShipyardRunRegistry_sol_ShipyardRunRegistry.abi');

const existing = await loadExistingAuthorization();
if (existing) {
  process.stdout.write(`${JSON.stringify({ ...existing, reused: true }, null, 2)}\n`);
  process.exit(0);
}

const stored = JSON.parse(await readFile(signerPath, 'utf8'));
if (stored.network !== 'botchain-testnet-only' || stored.chainId !== Number(EXPECTED_CHAIN_ID)) {
  throw new Error('Refusing to authorize an attestor with a signer not explicitly scoped to BOT Chain testnet');
}
const deployment = JSON.parse(await readFile(deploymentPath, 'utf8'));
if (deployment.environment !== 'botchain-testnet' || deployment.chainId !== Number(EXPECTED_CHAIN_ID)) {
  throw new Error('Registry deployment record is not scoped to BOT Chain testnet');
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

const attestor = wallet.address;
const alreadyAuthorized = await registry.authorizedAttestors(attestor);
let transactionHash = null;
if (!alreadyAuthorized) {
  const tx = await registry.setAttestor(attestor, true);
  const receipt = await tx.wait(1);
  if (receipt?.status !== 1) throw new Error('setAttestor transaction did not confirm successfully');
  transactionHash = tx.hash;
}
if (!(await registry.authorizedAttestors(attestor))) {
  throw new Error('Attestor authorization did not take effect on-chain');
}

const result = {
  environment: 'botchain-testnet',
  chainId: Number(EXPECTED_CHAIN_ID),
  registryAddress: deployment.contractAddress,
  attestor,
  transactionHash,
  explorerUrl: transactionHash ? `https://scan.bohr.life/tx/${transactionHash}` : null,
};
await writeFile(authorizationPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ ...result, reused: false }, null, 2)}\n`);

async function loadExistingAuthorization() {
  try {
    return JSON.parse(await readFile(authorizationPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}
