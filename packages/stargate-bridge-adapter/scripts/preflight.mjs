// Read-only cross-chain USDC preflight. Gathers on-chain + endpoint facts and prints a go/no-go
// report. Moves no funds, signs nothing, prints no secrets (only derived public addresses).
//
// Run from this package directory:  node scripts/preflight.mjs
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Contract, JsonRpcProvider, Wallet } from 'ethers';

import { evaluateCrossChainPreflight } from '../dist/preflight.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(HERE, '../../../.env');

// Public, on-chain-verified route constants (mirrors GOAT_TO_BNB_USDC_STARGATE_ROUTE).
const GOAT_USDC_POOL = '0xbbA60da06c2c5424f03f7434542280FCAd453d10';
const GOAT_USDC_TOKEN = '0x3022b87ac063DE95b1570F46f5e470F8B53112D8';
const BNB_USDC_POOL = '0x962Bd449E630b0d928f308Ce63f1A21F02576057';
const BNB_USDC_TOKEN = '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d';

const DEFAULT_BRIDGE_AMOUNT_ATOMIC = '250000'; // 0.25 USDC
const MIN_GOAT_GAS_WEI = '500000000000000'; // 0.0005 BTC, conservative floor
const MIN_BNB_GAS_WEI = '500000000000000'; // 0.0005 BNB

const POOL_ABI = ['function token() view returns (address)'];
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];

function parseEnv() {
  const out = {};
  for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0 && !line.trimStart().startsWith('#')) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

function sameAddress(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

async function poolFacts(provider, pool, expectedToken) {
  const code = await provider.getCode(pool).catch(() => '0x');
  const live = code && code !== '0x';
  let token = null;
  if (live) token = await new Contract(pool, POOL_ABI, provider).token().catch(() => null);
  return { live: Boolean(live), matches: sameAddress(token, expectedToken) };
}

async function main() {
  const env = parseEnv();
  const goat = new JsonRpcProvider(env.GOAT_MAINNET_RPC_URL || 'https://rpc.goat.network', 2345, {
    staticNetwork: true,
  });
  const bnbRpc = env.BNB_RPC_URL || 'https://bsc-dataseed1.bnbchain.org';
  const bnb = new JsonRpcProvider(bnbRpc, 56, { staticNetwork: true });

  // GOAT signer (address derived, key never printed).
  const signerKey = env.ORCHESTRATOR_SIGNER_PRIVATE_KEY;
  if (!signerKey || !/^0x[0-9a-fA-F]{64}$/.test(signerKey)) {
    throw new Error('ORCHESTRATOR_SIGNER_PRIVATE_KEY missing or not a raw hex key -- cannot derive the GOAT signer');
  }
  const signerAddress = new Wallet(signerKey).address;

  const [source, destination, usdcBalance, goatGas] = await Promise.all([
    poolFacts(goat, GOAT_USDC_POOL, GOAT_USDC_TOKEN),
    poolFacts(bnb, BNB_USDC_POOL, BNB_USDC_TOKEN),
    new Contract(GOAT_USDC_TOKEN, ERC20_ABI, goat).balanceOf(signerAddress),
    goat.getBalance(signerAddress),
  ]);

  const crossChainConfigured =
    (env.CROSS_CHAIN_PROCUREMENT_MODE ?? 'disabled') !== 'disabled' && Boolean(env.BNB_X402_ENDPOINT);

  const bnbFacts = { configured: crossChainConfigured };
  if (crossChainConfigured) {
    if (env.BNB_X402_PAYER_PRIVATE_KEY && /^0x[0-9a-fA-F]{64}$/.test(env.BNB_X402_PAYER_PRIVATE_KEY)) {
      const payer = new Wallet(env.BNB_X402_PAYER_PRIVATE_KEY).address;
      bnbFacts.payerAddress = payer;
      bnbFacts.nativeGasWei = (await bnb.getBalance(payer)).toString();
      bnbFacts.minGasWei = MIN_BNB_GAS_WEI;
    }
    try {
      const res = await fetch(env.BNB_X402_ENDPOINT, { method: 'GET' });
      bnbFacts.endpointReachable = true;
      bnbFacts.endpointStatus = res.status;
    } catch {
      bnbFacts.endpointReachable = false;
    }
    if (env.BNB_X402_TARGET_AMOUNT_ATOMIC) bnbFacts.targetAmountAtomic = env.BNB_X402_TARGET_AMOUNT_ATOMIC;
    if (env.BNB_X402_MAX_PRICE_ATOMIC) bnbFacts.maxTargetAmountAtomic = env.BNB_X402_MAX_PRICE_ATOMIC;
  }

  const report = evaluateCrossChainPreflight({
    route: {
      sourcePoolLive: source.live,
      sourceTokenMatches: source.matches,
      destinationPoolLive: destination.live,
      destinationTokenMatches: destination.matches,
    },
    goat: { signerAddress, usdcBalanceAtomic: usdcBalance.toString(), nativeGasWei: goatGas.toString() },
    bridgeAmountAtomic: env.CROSS_CHAIN_SOURCE_BRIDGE_AMOUNT_ATOMIC || DEFAULT_BRIDGE_AMOUNT_ATOMIC,
    minGoatGasWei: MIN_GOAT_GAS_WEI,
    bnb: bnbFacts,
  });

  const icon = { pass: '✓', fail: '✗', warn: '!', skip: '·' };
  console.log('\nCross-chain USDC preflight (read-only, no funds moved)\n');
  console.log(`GOAT signer: ${signerAddress}`);
  if (!env.CROSS_CHAIN_SOURCE_BRIDGE_AMOUNT_ATOMIC) {
    console.log(`(bridge amount not set; assuming ${DEFAULT_BRIDGE_AMOUNT_ATOMIC} atomic USDC for this check)`);
  }
  console.log('');
  for (const check of report.checks) {
    console.log(`  [${icon[check.status] ?? '?'}] ${check.status.toUpperCase().padEnd(4)}  ${check.name}`);
    console.log(`         ${check.detail}`);
  }
  console.log(`\nVERDICT: ${report.ok ? 'GO (no blocking failures)' : 'NO-GO (see failures above)'}\n`);
  process.exitCode = report.ok ? 0 : 1;
}

await main().catch((error) => {
  console.error('preflight failed:', error.message);
  process.exitCode = 2;
});
