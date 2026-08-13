/**
 * Creates (or re-reads) the dedicated BNB Chain x402 payer wallet.
 *
 * This is deliberately its own wallet, separate from every GOAT signer and from the merchant
 * receiving address: the wallet that *collects* customer payments must never be the wallet that
 * *spends* on targets, and a compromise of a small spending balance should not reach anything else.
 *
 * Unlike scripts/testnet/create-wallet.mjs this key is for BNB **mainnet** and will hold real
 * value, so the file is written 0600 under .local/ (gitignored) and the key is never printed.
 * Fund it only with the small stablecoin balance a run actually needs.
 */
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { Wallet } from 'ethers';

const BNB_MAINNET_CHAIN_ID = 56;
const NETWORK = 'bnb-mainnet-x402-payer';

const walletPath = resolve('.local/bnb/bnb-mainnet-x402-payer.json');
await mkdir(dirname(walletPath), { recursive: true, mode: 0o700 });

let wallet;
let created = false;
try {
  const stored = JSON.parse(await readFile(walletPath, 'utf8'));
  if (stored.network !== NETWORK || stored.chainId !== BNB_MAINNET_CHAIN_ID || typeof stored.privateKey !== 'string') {
    throw new Error('Existing BNB payer signer file has an unexpected format');
  }
  wallet = new Wallet(stored.privateKey);
  if (wallet.address.toLowerCase() !== String(stored.address).toLowerCase()) {
    throw new Error('Existing BNB payer signer address does not match its private key');
  }
  await chmod(walletPath, 0o600);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
  wallet = Wallet.createRandom();
  created = true;
  await writeFile(
    walletPath,
    `${JSON.stringify(
      {
        network: NETWORK,
        chainId: BNB_MAINNET_CHAIN_ID,
        address: wallet.address,
        privateKey: wallet.privateKey,
        warning:
          'BNB MAINNET spending key. Fund only with the small amount a run needs. Never reuse for collection or attestation.',
      },
      null,
      2,
    )}\n`,
    { flag: 'wx', mode: 0o600 },
  );
}

process.stdout.write(
  `${JSON.stringify({
    network: NETWORK,
    chainId: BNB_MAINNET_CHAIN_ID,
    address: wallet.address,
    signerFile: walletPath,
    created,
    // The EIP-3009 path needs no native BNB: the payer only signs, and the facilitator submits
    // the on-chain transfer. Fund this with the settlement stablecoin, not with gas.
    fundWith: 'USD1 (0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d) on BNB Chain',
  })}\n`,
);
