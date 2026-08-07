import { createEgressSafeFetch } from '@shipyard402/policy-engine';

import type { PurchaseClient } from './ports.js';

const egressSafeFetch = createEgressSafeFetch();

/**
 * Must produce byte-identical text to apps/x402-demo-target's purchaseClaimMessage -- the demo
 * target recovers the signer from this exact string and rejects the claim if it doesn't match the
 * transaction's on-chain sender.
 */
function purchaseClaimMessage(transactionHash: string): string {
  return `Shipyard402 x402-demo-target purchase claim: ${transactionHash.toLowerCase()}`;
}

export interface PurchaseClaimSigner {
  signMessage(message: string): Promise<string>;
}

/**
 * The signer must be the same wallet that broadcast the procurement payment: the demo target
 * verifies this signature recovers to the payment transaction's sender before honoring the claim,
 * which is what stops an observer of the (public) transaction hash from racing the real payer to
 * steal the one-time receipt.
 */
export function createFetchPurchaseClient(baseUrl: string, signer: PurchaseClaimSigner): PurchaseClient {
  return {
    async purchase(transactionHash) {
      const signature = await signer.signMessage(purchaseClaimMessage(transactionHash));
      const response = await egressSafeFetch(new URL('/purchase', baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ transactionHash, signature }),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Demo target rejected the earned payment: ${response.status} ${body}`);
      }
      return await response.json() as Readonly<{ receipt: string }>;
    },
  };
}
