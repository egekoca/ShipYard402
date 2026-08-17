import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { Contract, JsonRpcProvider, Wallet } from 'ethers';

// Drives one complete run through the BOT Chain testnet stack: login, onboard the target, quote,
// create the run, pay the customer leg on-chain from a disposable testnet wallet, then follow the
// run until the orchestrator finishes. Everything it touches is testnet-only.
const API = process.env.API_BASE_URL ?? 'http://127.0.0.1:3011';
const TARGET = process.env.TARGET_BASE_URL;
if (!TARGET) throw new Error('TARGET_BASE_URL (the public https URL of the demo target) is required');
const RPC_URL = 'https://rpc.bohr.life';
const EXPECTED_CHAIN_ID = 968n;

const stored = JSON.parse(await readFile(resolve('.local/testnet/botchain-testnet-customer-wallet.json'), 'utf8'));
if (stored.network !== 'botchain-testnet-only' || stored.chainId !== Number(EXPECTED_CHAIN_ID)) {
  throw new Error('Refusing to run with a signer not explicitly scoped to BOT Chain testnet');
}
const provider = new JsonRpcProvider(RPC_URL, Number(EXPECTED_CHAIN_ID), { staticNetwork: true });
if ((await provider.getNetwork()).chainId !== EXPECTED_CHAIN_ID) throw new Error('RPC chain mismatch');
const customer = new Wallet(stored.privateKey, provider);

const log = (step, data) => process.stdout.write(`${JSON.stringify({ step, ...data })}\n`);

async function call(path, { method = 'GET', body, token, allowStatus = [] } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = text;
  }
  if (!response.ok && !allowStatus.includes(response.status)) {
    throw new Error(`${method} ${path} -> ${response.status} ${JSON.stringify(payload)}`);
  }
  return payload;
}

// 1. Session
const issuedAt = Math.floor(Date.now() / 1000);
const signature = await customer.signMessage(
  `Shipyard402 login\naddress: ${customer.address.toLowerCase()}\nissued at: ${issuedAt}`,
);
const session = await call('/v1/auth/session', {
  method: 'POST',
  body: { address: customer.address, signature, issuedAt },
});
const token = session.token ?? session.accessToken;
log('session', { address: customer.address });

// 2. Onboard the target service
const externalServiceId = `botchain-selftest-${Date.now()}`;
const onboarded = await call('/v1/services/onboard', {
  method: 'POST',
  token,
  body: {
    organizationName: 'Shipyard402 BOT Chain self-test',
    requesterAddress: customer.address,
    externalServiceId,
    serviceName: 'x402 demo target (BOT Chain)',
    x402Endpoint: `${TARGET}/paid/resource`,
    openApiUrl: `${TARGET}/openapi.json`,
    version: '0.1.0',
    marketplaceListed: false,
    chainId: 968,
  },
});
log('onboarded', onboarded);

// 3. Quote
const quote = await call('/v1/quotes', {
  method: 'POST',
  token,
  body: {
    organizationId: onboarded.organizationId,
    requesterAddress: customer.address,
    targetAgentId: onboarded.targetAgentId,
    targetServiceId: onboarded.targetServiceId,
    targetVersionHash: onboarded.targetVersionHash,
    policyHash: onboarded.policyHash,
    x402Endpoint: onboarded.x402Endpoint,
    openApiUrl: onboarded.openApiUrl,
    maximumCustomerBudgetAtomic: '100000000000000000000',
  },
});
log('quoted', { quoteId: quote.id, total: quote.totalAtomicAmount });

// 4. Run
const run = await call('/v1/runs', {
  method: 'POST',
  token,
  body: { quoteId: quote.id, idempotencyKey: randomUUID() },
});
const runId = run.run.id;
log('run_created', { runId, status: run.run.status });

// 5. Payment challenge
// 402 is the designed answer here: the challenge itself is a payment-required response.
const challenged = await call(`/v1/runs/${runId}/payment-challenge`, { method: 'POST', token, allowStatus: [402] });
log('payment_challenge', { status: challenged.run.status, payment: challenged.payment });

const accepts = challenged.payment?.paymentRequired?.accepts?.[0];
const payTo = accepts?.payTo;
const asset = accepts?.asset;
const amount = accepts?.amount ?? quote.totalAtomicAmount;
if (!payTo || !asset) {
  throw new Error(`Payment challenge did not expose an asset/recipient: ${JSON.stringify(challenged.payment)}`);
}

// 6. Real customer payment on BOT Chain
const token20 = new Contract(
  asset,
  ['function transfer(address to, uint256 value) returns (bool)', 'function balanceOf(address) view returns (uint256)'],
  customer,
);
const tx = await token20.transfer(payTo, BigInt(amount));
const receipt = await tx.wait(1);
log('customer_payment', {
  transactionHash: tx.hash,
  explorerUrl: `https://scan.bohr.life/tx/${tx.hash}`,
  block: receipt.blockNumber,
  status: receipt.status,
  amount: String(amount),
  payTo,
});

// 7. Hand the transaction to the gateway
await call(`/v1/runs/${runId}/payment-tx`, { method: 'POST', token, body: { transactionHash: tx.hash } });
log('payment_submitted', { runId });

// 8. Follow the run
const terminal = new Set([
  'DELIVERED_PASS',
  'DELIVERED_FAIL',
  'DELIVERED_CONDITIONAL',
  'DELIVERED_INCONCLUSIVE',
  'FAILED',
  'EXPIRED',
]);
let last = '';
for (let i = 0; i < 240; i += 1) {
  const current = await call(`/v1/runs/${runId}`, { token });
  const status = current.run.status;
  if (status !== last) {
    last = status;
    log('status', { runId, status });
  }
  if (terminal.has(status)) {
    log('final', { runId, status, run: current.run });
    break;
  }
  await new Promise((r) => setTimeout(r, 5000));
}
