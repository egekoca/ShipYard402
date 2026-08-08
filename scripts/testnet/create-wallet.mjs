import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { Wallet } from 'ethers';

const label = process.argv[2];
if (label !== undefined && !/^[a-z0-9-]{1,64}$/.test(label)) {
  throw new Error('Wallet label must match [a-z0-9-]{1,64}');
}
const walletPath = resolve(`.local/testnet/goat-testnet3-${label ?? 'wallet'}.json`);
await mkdir(dirname(walletPath), { recursive: true, mode: 0o700 });

let wallet;
try {
  const stored = JSON.parse(await readFile(walletPath, 'utf8'));
  if (stored.network !== 'goat-testnet3-only' || stored.chainId !== 48816 || typeof stored.privateKey !== 'string') {
    throw new Error('Existing testnet signer file has an unexpected format');
  }
  wallet = new Wallet(stored.privateKey);
  if (wallet.address.toLowerCase() !== String(stored.address).toLowerCase()) {
    throw new Error('Existing testnet signer address does not match its private key');
  }
  await chmod(walletPath, 0o600);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
  wallet = Wallet.createRandom();
  await writeFile(
    walletPath,
    `${JSON.stringify(
      {
        network: 'goat-testnet3-only',
        chainId: 48816,
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
    network: 'goat-testnet3',
    chainId: 48816,
    address: wallet.address,
    signerFile: walletPath,
  })}\n`,
);
