import type { PurchaseClient } from './ports.js';

export function createFetchPurchaseClient(baseUrl: string): PurchaseClient {
  return {
    async purchase(transactionHash) {
      const response = await fetch(new URL('/purchase', baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ transactionHash }),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Demo target rejected the earned payment: ${response.status} ${body}`);
      }
      return await response.json() as Readonly<{ receipt: string }>;
    },
  };
}
