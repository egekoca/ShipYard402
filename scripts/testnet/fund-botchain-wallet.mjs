import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { JsonRpcProvider, Wallet, formatEther, getAddress, parseEther } from 'ethers';

// Moves BOT Chain testnet gas from the deploy signer to another testnet role wallet (customer,
// settler, ...). Testnet only and capped: this script can never move a large amount, and it
// refuses to run against any chain other than 968.
const RPC_URL = 'https://rpc.bohr.life';
const EXPECTED_CHAIN_ID = 968n;
const MAX_AMOUNT_WEI = parseEther('1');

const [, , toArg, amountArg] = process.argv;
if (!toArg || !/^0x[a-fA-F0-9]{40}$/.test(toArg)) {
  throw new Error('Usage: node scripts/testnet/fund-botchain-wallet.mjs <0xRecipient> [amountInBot=0.5]');
}
const to = getAddress(toArg);
const amountWei = parseEther(amountArg ?? '0.5');
if (amountWei <= 0n || amountWei > MAX_AMOUNT_WEI) {
  throw new Error(`Refusing to send more than ${formatEther(MAX_AMOUNT_WEI)} BOT in one transfer`);
}

const stored = JSON.parse(await readFile(resolve('.local/testnet/botchain-testnet-wallet.json'), 'utf8'));
if (stored.network !== 'botchain-testnet-only' || stored.chainId !== Number(EXPECTED_CHAIN_ID)) {
  throw new Error('Refusing to fund with a signer not explicitly scoped to BOT Chain testnet');
}

const provider = new JsonRpcProvider(RPC_URL, Number(EXPECTED_CHAIN_ID), { staticNetwork: true });
const network = await provider.getNetwork();
if (network.chainId !== EXPECTED_CHAIN_ID) throw new Error(`RPC chain mismatch: ${network.chainId}`);
const wallet = new Wallet(stored.privateKey, provider);
if (wallet.address.toLowerCase() !== String(stored.address).toLowerCase()) {
  throw new Error('Testnet signer address mismatch');
}

const tx = await wallet.sendTransaction({ to, value: amountWei });
const receipt = await tx.wait(1);
if (receipt?.status !== 1) throw new Error('Funding transaction did not confirm successfully');

process.stdout.write(
  `${JSON.stringify(
    {
      from: wallet.address,
      to,
      amountBot: formatEther(amountWei),
      transactionHash: tx.hash,
      explorerUrl: `https://scan.bohr.life/tx/${tx.hash}`,
      blockNumber: receipt.blockNumber,
      recipientBalanceBot: formatEther(await provider.getBalance(to)),
    },
    null,
    2,
  )}\n`,
);
