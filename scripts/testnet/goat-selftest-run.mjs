import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { Contract, JsonRpcProvider, Wallet } from 'ethers';

// Drives one complete run through the GOAT Testnet3 stack: login, onboard the target, quote,
// create the run, pay the GOAT Flow order on-chain from a disposable testnet wallet, then follow
// the run until the orchestrator finishes. Testnet only.
const API = process.env.API_BASE_URL ?? 'http://127.0.0.1:3001';
const TARGET = process.env.TARGET_BASE_URL;
if (!TARGET) throw new Error('TARGET_BASE_URL (the public https URL of the demo target) is required');
const RPC_URL = 'https://rpc.testnet3.goat.network';
const EXPECTED_CHAIN_ID = 48816n;

const stored = JSON.parse(await readFile(resolve('.local/testnet/goat-testnet3-wallet.json'), 'utf8'));
if (stored.network !== 'goat-testnet3-only' || stored.chainId !== Number(EXPECTED_CHAIN_ID)) {
  throw new Error('Refusing to run with a signer not explicitly scoped to GOAT Testnet3');
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

const onboarded = await call('/v1/services/onboard', {
  method: 'POST',
  token,
  body: {
    organizationName: 'Shipyard402 GOAT self-test',
    requesterAddress: customer.address,
    externalServiceId: `goat-selftest-${Date.now()}`,
    serviceName: 'x402 demo target (GOAT Testnet3)',
    x402Endpoint: `${TARGET}/paid/resource`,
    openApiUrl: `${TARGET}/openapi.json`,
    version: '0.1.0',
    marketplaceListed: false,
    chainId: 48816,
  },
});
log('onboarded', { targetServiceId: onboarded.targetServiceId, targetVersionHash: onboarded.targetVersionHash });

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
    maximumCustomerBudgetAtomic: '5000000',
  },
});
log('quoted', { quoteId: quote.id, total: quote.totalAtomicAmount });

const run = await call('/v1/runs', {
  method: 'POST',
  token,
  body: { quoteId: quote.id, idempotencyKey: randomUUID() },
});
const runId = run.run.id;
log('run_created', { runId, status: run.run.status });

// 402 is the designed answer here: the challenge itself is a payment-required response.
const challenged = await call(`/v1/runs/${runId}/payment-challenge`, { method: 'POST', token, allowStatus: [402] });
const accepts = challenged.payment?.paymentRequired?.accepts?.[0];
const payTo = accepts?.payTo ?? accepts?.payToAddress;
const asset = accepts?.asset ?? accepts?.tokenAddress;
const amount = accepts?.amount ?? accepts?.maxAmountRequired ?? quote.totalAtomicAmount;
log('payment_challenge', { orderId: challenged.payment?.orderId, payTo, asset, amount });
if (!payTo || !asset)
  throw new Error(`Challenge did not expose an asset/recipient: ${JSON.stringify(challenged.payment)}`);

const erc20 = new Contract(asset, ['function transfer(address to, uint256 value) returns (bool)'], customer);
const tx = await erc20.transfer(payTo, BigInt(amount));
const receipt = await tx.wait(1);
log('customer_payment', {
  transactionHash: tx.hash,
  explorerUrl: `https://explorer.testnet3.goat.network/tx/${tx.hash}`,
  block: receipt.blockNumber,
  status: receipt.status,
  amount: String(amount),
  payTo,
});

// GOAT Flow discovers the payment on its own side; there is no transaction hand-off to make here.
const terminal = new Set([
  'DELIVERED_PASS',
  'DELIVERED_FAIL',
  'DELIVERED_CONDITIONAL',
  'DELIVERED_INCONCLUSIVE',
  'FAILED',
  'EXPIRED',
]);
let last = '';
for (let i = 0; i < 360; i += 1) {
  const current = await call(`/v1/runs/${runId}`, { token });
  const status = current.run.status;
  if (status !== last) {
    last = status;
    log('status', { runId, status });
  }
  if (terminal.has(status)) {
    log('final', { runId, status, result: current.run.result ?? null });
    break;
  }
  await new Promise((r) => setTimeout(r, 5000));
}
