import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Contract, ContractFactory, JsonRpcProvider, Wallet, formatEther, getAddress, keccak256 } from 'ethers';

const RPC_URL = 'https://rpc.testnet3.goat.network';
const EXPECTED_CHAIN_ID = 48816n;
const MAX_DEPLOYMENT_COST_WEI = 2_000_000_000_000n;
const signerPath = resolve('.local/testnet/goat-testnet3-wallet.json');
const deploymentPath = resolve('.local/testnet/shipyard-test-token.json');
const artifactPath = resolve('contracts/out/ShipyardTestToken.sol/ShipyardTestToken.json');

const stored = JSON.parse(await readFile(signerPath, 'utf8'));
if (stored.network !== 'goat-testnet3-only' || stored.chainId !== Number(EXPECTED_CHAIN_ID)) {
  throw new Error('Refusing to deploy with a signer not explicitly scoped to GOAT Testnet3');
}
const provider = new JsonRpcProvider(RPC_URL, Number(EXPECTED_CHAIN_ID), { staticNetwork: true });
const network = await provider.getNetwork();
if (network.chainId !== EXPECTED_CHAIN_ID) throw new Error(`RPC chain mismatch: ${network.chainId}`);
const wallet = new Wallet(stored.privateKey, provider);
if (wallet.address.toLowerCase() !== String(stored.address).toLowerCase()) {
  throw new Error('Testnet signer address mismatch');
}

const existing = await loadExistingDeployment();
if (existing) {
  const code = await provider.getCode(existing.contractAddress);
  if (code !== '0x') {
    process.stdout.write(`${JSON.stringify({ ...existing, reused: true }, null, 2)}\n`);
    process.exit(0);
  }
  throw new Error('Existing deployment record points to an address without bytecode');
}

const artifact = JSON.parse(await readFile(artifactPath, 'utf8'));
const factory = new ContractFactory(artifact.abi, artifact.bytecode.object, wallet);
const unsigned = await factory.getDeployTransaction(wallet.address);
const [estimatedGas, feeData, balance] = await Promise.all([
  wallet.estimateGas(unsigned),
  provider.getFeeData(),
  provider.getBalance(wallet.address),
]);
const feePerGas = feeData.maxFeePerGas ?? feeData.gasPrice;
if (!feePerGas || feePerGas <= 0n) throw new Error('RPC did not provide a usable deployment fee');
const gasLimit = (estimatedGas * 120n) / 100n;
const maximumCost = gasLimit * feePerGas;
if (maximumCost > MAX_DEPLOYMENT_COST_WEI || maximumCost > balance) {
  throw new Error(`Deployment cost bound exceeded: ${maximumCost}`);
}

const contract = await factory.deploy(wallet.address, {
  gasLimit,
  ...(feeData.maxFeePerGas ? { maxFeePerGas: feeData.maxFeePerGas } : {}),
  ...(feeData.maxPriorityFeePerGas ? { maxPriorityFeePerGas: feeData.maxPriorityFeePerGas } : {}),
});
const transaction = contract.deploymentTransaction();
if (!transaction) throw new Error('Deployment transaction was not created');
const receipt = await transaction.wait(1);
if (receipt?.status !== 1 || transaction.chainId !== EXPECTED_CHAIN_ID) {
  throw new Error('Token deployment was not successful on GOAT Testnet3');
}
const contractAddress = getAddress(await contract.getAddress());
const code = await provider.getCode(contractAddress);
if (code === '0x') throw new Error('No runtime bytecode found after deployment');
const token = new Contract(contractAddress, artifact.abi, provider);
const [owner, symbol, decimals] = await Promise.all([token.owner(), token.symbol(), token.decimals()]);
if (getAddress(owner) !== wallet.address) throw new Error('Token owner does not match the isolated testnet signer');

const result = {
  environment: 'testnet3',
  chainId: Number(EXPECTED_CHAIN_ID),
  rpcUrl: RPC_URL,
  explorerUrl: `https://explorer.testnet3.goat.network/address/${contractAddress}`,
  deployer: wallet.address,
  owner: getAddress(owner),
  contractAddress,
  symbol,
  decimals: Number(decimals),
  transactionHash: transaction.hash,
  blockNumber: receipt.blockNumber,
  gasUsed: receipt.gasUsed.toString(),
  feeWei: receipt.fee.toString(),
  feeBtc: formatEther(receipt.fee),
  runtimeBytecodeHash: keccak256(code),
  warning: 'TESTNET ONLY. No value. Never deploy or reference on Mainnet.',
};
await writeFile(deploymentPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
process.stdout.write(`${JSON.stringify({ ...result, reused: false }, null, 2)}\n`);

async function loadExistingDeployment() {
  try {
    const value = JSON.parse(await readFile(deploymentPath, 'utf8'));
    if (value.environment !== 'testnet3' || value.chainId !== Number(EXPECTED_CHAIN_ID)) {
      throw new Error('Existing test token deployment is not scoped to GOAT Testnet3');
    }
    return value;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}
