import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Wallet } from 'ethers';

/**
 * Re-points the listed demo target at whatever public URL it is reachable on right now.
 *
 * A quick cloudflared tunnel gets a new hostname every time it restarts, but the directory stores
 * the URL a service was onboarded with -- so after a restart the listing points somewhere that no
 * longer resolves, and a customer run pays for real and then fails at procurement against a dead
 * host. Onboarding again is what re-hashes the OpenAPI document and rebinds the listing, so this
 * runs as part of bringing the local backend up rather than being remembered by hand.
 */
const API = process.env.API_BASE_URL ?? 'http://127.0.0.1:3001';
const TARGET = process.env.DEMO_TARGET_BASE_URL ?? process.env.TARGET_BASE_URL;
if (!TARGET) throw new Error('DEMO_TARGET_BASE_URL (the target public https URL) is required');

const stored = JSON.parse(await readFile(resolve('.local/testnet/goat-testnet3-wallet.json'), 'utf8'));
if (stored.network !== 'goat-testnet3-only' || stored.chainId !== 48816) {
  throw new Error('Refusing to onboard with a signer not explicitly scoped to GOAT Testnet3');
}
const wallet = new Wallet(stored.privateKey);
const issuedAt = Math.floor(Date.now() / 1000);
const signature = await wallet.signMessage(
  `Shipyard402 login\naddress: ${wallet.address.toLowerCase()}\nissued at: ${issuedAt}`,
);
const session = await (
  await fetch(`${API}/v1/auth/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address: wallet.address, signature, issuedAt }),
  })
).json();
const token = session.token ?? session.accessToken;

const response = await fetch(`${API}/v1/services/onboard`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({
    organizationName: 'Shipyard402',
    requesterAddress: wallet.address,
    externalServiceId: 'service:x402-demo-target:testnet3-real-merchant',
    serviceName: 'GOAT Testnet Paid API',
    x402Endpoint: `${TARGET}/paid/resource`,
    openApiUrl: `${TARGET}/openapi.json`,
    version: '0.1.0',
    marketplaceListed: true,
    chainId: 48816,
    description:
      "Shipyard's own x402 reference service on GOAT Testnet3. It charges a real on-chain payment per call and ships in two modes: one with the receipt-replay bug, one with it fixed.",
  }),
});
const body = await response.text();
if (!response.ok) throw new Error(`Onboarding failed: ${response.status} ${body.slice(0, 300)}`);
process.stdout.write(`${JSON.stringify({ relistedAt: `${TARGET}/paid/resource`, status: response.status })}\n`);
