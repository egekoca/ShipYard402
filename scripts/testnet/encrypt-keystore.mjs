import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Wallet } from 'ethers';

const label = process.argv[2];
if (!label || !/^[a-z0-9-]{1,64}$/.test(label)) {
  throw new Error('Usage: KEYSTORE_PASSWORD=... node scripts/testnet/encrypt-keystore.mjs <wallet-label>');
}
const password = process.env.KEYSTORE_PASSWORD;
if (!password || password.length < 12) {
  throw new Error('KEYSTORE_PASSWORD env var is required and must be at least 12 characters');
}

const walletPath = resolve(`.local/testnet/goat-testnet3-${label}.json`);
const stored = JSON.parse(await readFile(walletPath, 'utf8'));
if (stored.network !== 'goat-testnet3-only' || typeof stored.privateKey !== 'string') {
  throw new Error(`${walletPath} is not a recognized testnet signer file`);
}
const wallet = new Wallet(stored.privateKey);
if (wallet.address.toLowerCase() !== String(stored.address).toLowerCase()) {
  throw new Error('Signer file address does not match its private key');
}

const keystoreJson = await wallet.encrypt(password);
const keystorePath = resolve(`.local/testnet/goat-testnet3-${label}-keystore.json`);
await writeFile(keystorePath, keystoreJson, { flag: 'wx', mode: 0o600 });

process.stdout.write(JSON.stringify({
  address: wallet.address,
  keystoreFile: keystorePath,
  note: 'Set the *_KEYSTORE_PATH env var to this file and *_KEYSTORE_PASSWORD to the password used here; delete the plaintext signer file once you have verified it decrypts.',
}) + '\n');
