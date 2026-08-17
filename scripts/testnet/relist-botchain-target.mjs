import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Wallet } from 'ethers';

/**
 * Publishes the controlled BOT Chain testnet target in the BOT API's marketplace. Quick tunnel
 * hostnames change whenever the local target is restarted, so this command intentionally uses a
 * stable externalServiceId and onboards it again with the current HTTPS URL.
 */
// biome-ignore lint/suspicious/noUndeclaredEnvVars: standalone operator script, not a cached Turbo task
const API = process.env.API_BASE_URL ?? 'http://127.0.0.1:3011';
// biome-ignore lint/suspicious/noUndeclaredEnvVars: standalone operator script, not a cached Turbo task
const TARGET = process.env.BOT_TARGET_BASE_URL ?? process.env.TARGET_BASE_URL;
if (!TARGET) throw new Error('BOT_TARGET_BASE_URL (the target public https URL) is required');

const stored = JSON.parse(await readFile(resolve('.local/testnet/botchain-testnet-customer-wallet.json'), 'utf8'));
if (stored.network !== 'botchain-testnet-only' || stored.chainId !== 968) {
  throw new Error('Refusing to onboard with a signer not explicitly scoped to BOT Chain testnet');
}

const wallet = new Wallet(stored.privateKey);
const issuedAt = Math.floor(Date.now() / 1000);
const signature = await wallet.signMessage(
  `Shipyard402 login\naddress: ${wallet.address.toLowerCase()}\nissued at: ${issuedAt}`,
);

async function jsonCall(path, options = {}) {
  const response = await fetch(`${API}${path}`, options);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!response.ok) throw new Error(`${path} -> ${response.status} ${JSON.stringify(body)}`);
  return body;
}

const session = await jsonCall('/v1/auth/session', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ address: wallet.address, signature, issuedAt }),
});
const token = session.token ?? session.accessToken;

const onboarded = await jsonCall('/v1/services/onboard', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({
    organizationName: 'Shipyard402',
    requesterAddress: wallet.address,
    externalServiceId: 'service:x402-demo-target:botchain-testnet',
    serviceName: 'BOT Chain Testnet Paid API',
    x402Endpoint: `${TARGET}/paid/resource`,
    openApiUrl: `${TARGET}/openapi.json`,
    version: '0.1.0',
    marketplaceListed: true,
    chainId: 968,
    description:
      'Shipyard402 controlled x402 target on BOT Chain testnet. It settles a real test-token payment on-chain and exposes replay, forged-payment and unpaid-access scenarios.',
  }),
});

process.stdout.write(
  `${JSON.stringify({
    targetServiceId: onboarded.targetServiceId,
    x402Endpoint: onboarded.x402Endpoint,
    marketplaceListed: true,
    chainId: 968,
  })}\n`,
);
