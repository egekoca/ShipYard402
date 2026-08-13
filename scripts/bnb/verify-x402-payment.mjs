/**
 * Exercises the BNB x402 payer against a real, third-party paid API.
 *
 * Two stages, because the first spends nothing and the second spends real money:
 *   (no flag)  read the target's 402 challenge and report which entry our policy would pay,
 *              or every reason it would refuse. No signature, no funds move.
 *   --pay      additionally sign the authorization and call the endpoint with it, which settles
 *              the payment on BNB Chain.
 *
 * The policy here is the same shape the orchestrator uses: only BNB mainnet, only assets this
 * payer actually holds, and a hard per-call ceiling. The recipient is deliberately NOT pinned --
 * paying a service we do not control is the whole point of this check.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  BNB_MAINNET_NETWORK,
  BNB_USD1,
  createOfficialBnbX402PaidRequestPort,
} from '../../packages/bnb-x402-client/dist/index.js';

const endpoint = process.argv.find((argument) => argument.startsWith('http')) ?? 'https://api.syraa.fun/assets';
const pay = process.argv.includes('--pay');
/** 0.01 USD1. Well above the 0.001 this target charges, well below the wallet's whole balance. */
const maximumAtomicAmount = process.env.BNB_X402_MAX_ATOMIC ?? '10000000000000000';

const walletPath = resolve('.local/bnb/bnb-mainnet-x402-payer.json');
const stored = JSON.parse(await readFile(walletPath, 'utf8'));
if (stored.network !== 'bnb-mainnet-x402-payer' || stored.chainId !== 56) {
  throw new Error('Refusing to use a signer file that is not the scoped BNB payer');
}

const port = createOfficialBnbX402PaidRequestPort({
  rpcUrl: process.env.BNB_RPC_URL ?? 'https://bsc-dataseed.bnbchain.org',
  payerPrivateKey: stored.privateKey,
  endpoint,
  policy: {
    network: BNB_MAINNET_NETWORK,
    allowedAssets: [BNB_USD1],
    maximumAtomicAmount,
  },
});

const report = (event, detail) => process.stdout.write(`${JSON.stringify({ event, ...detail })}\n`);

let quote;
try {
  quote = await port.quote();
} catch (error) {
  report('unpayable', { endpoint, reason: String(error).slice(0, 400) });
  process.exitCode = 1;
  throw error;
}

report('quoted', {
  endpoint,
  payer: stored.address,
  amountAtomic: quote.amountAtomic,
  amountUsd1: Number(quote.amountAtomic) / 1e18,
  asset: quote.asset,
  payTo: quote.payTo,
  transferMethod: quote.transferMethod,
});

if (!pay) {
  report('dry_run_complete', { hint: 're-run with --pay to sign and settle this exact quote' });
  process.exit(0);
}

const authorized = await port.authorize(quote);
report('authorized', {
  amountAtomic: authorized.amountAtomic,
  paymentProofHash: authorized.paymentProofHash,
  receiptBytes: authorized.paymentReceipt.length,
});

const response = await fetch(endpoint, {
  method: 'GET',
  headers: { 'PAYMENT-SIGNATURE': authorized.paymentReceipt },
});
const settlement = response.headers.get('payment-response') ?? response.headers.get('x-payment-response');
const body = await response.text();
report('delivered', {
  status: response.status,
  settlementHeader: settlement ? JSON.parse(Buffer.from(settlement, 'base64').toString('utf8')) : null,
  bodyBytes: body.length,
  bodyPreview: body.slice(0, 300),
});
