import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { Wallet } from 'ethers';

// Generates the disposable BOT Chain testnet signer the botchain deploy scripts require. Mirrors
// create-wallet.mjs but scoped to BOT Chain (chain 968): a deliberately separate file so a GOAT
// signer can never satisfy a BOT deploy and vice versa. The private key is written only to a
// 0600, gitignored local file and never printed -- the process output carries the address only.
const EXPECTED_CHAIN_ID = 968;
const NETWORK_SCOPE = 'botchain-testnet-only';
// No label keeps the fixed name the botchain deploy scripts read exactly; a label creates an
// additional, separately-scoped signer for a distinct role (customer, merchant receiver, ...).
const label = process.argv[2];
if (label !== undefined && !/^[a-z0-9-]{1,64}$/.test(label)) {
  throw new Error('Wallet label must match [a-z0-9-]{1,64}');
}
const walletPath = resolve(
  label === undefined
    ? '.local/testnet/botchain-testnet-wallet.json'
    : `.local/testnet/botchain-testnet-${label}-wallet.json`,
);
await mkdir(dirname(walletPath), { recursive: true, mode: 0o700 });

let wallet;
try {
  const stored = JSON.parse(await readFile(walletPath, 'utf8'));
  if (
    stored.network !== NETWORK_SCOPE ||
    stored.chainId !== EXPECTED_CHAIN_ID ||
    typeof stored.privateKey !== 'string'
  ) {
    throw new Error('Existing BOT Chain testnet signer file has an unexpected format');
  }
  wallet = new Wallet(stored.privateKey);
  if (wallet.address.toLowerCase() !== String(stored.address).toLowerCase()) {
    throw new Error('Existing BOT Chain testnet signer address does not match its private key');
  }
  await chmod(walletPath, 0o600);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
  wallet = Wallet.createRandom();
  await writeFile(
    walletPath,
    `${JSON.stringify(
      {
        network: NETWORK_SCOPE,
        chainId: EXPECTED_CHAIN_ID,
        address: wallet.address,
        privateKey: wallet.privateKey,
        warning: 'TESTNET ONLY. Never fund or reuse this key on mainnet.',
      },
      null,
      2,
    )}\n`,
    { flag: 'wx', mode: 0o600 },
  );
}

process.stdout.write(
  `${JSON.stringify({
    network: 'botchain-testnet',
    chainId: EXPECTED_CHAIN_ID,
    address: wallet.address,
    signerFile: walletPath,
    fundWith: 'BOT Chain testnet gas (rpc https://rpc.bohr.life, explorer https://scan.bohr.life)',
  })}\n`,
);
