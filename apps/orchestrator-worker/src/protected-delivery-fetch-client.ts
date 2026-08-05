import { createEgressSafeFetch } from '@shipyard402/policy-engine';
import type { ProtectedDeliveryAttempt, ProtectedDeliveryClient } from '@shipyard402/protected-delivery-runner';
import { createHash } from 'node:crypto';

const egressSafeFetch = createEgressSafeFetch();

export function createFetchProtectedDeliveryClient(baseUrl: string): ProtectedDeliveryClient {
  return {
    async execute(input): Promise<ProtectedDeliveryAttempt> {
      const response = await egressSafeFetch(new URL(input.route, baseUrl), {
        method: input.method,
        headers: {
          'content-type': 'application/json',
          'x-payment-receipt': input.paymentReceipt,
          'x-idempotency-key': input.idempotencyKey,
        },
        ...(input.requestBody === undefined ? {} : { body: JSON.stringify(input.requestBody) }),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const bodyText = await response.text();
      const providerSignature = response.headers.get('x-provider-signature');

      return {
        statusCode: response.status,
        deliveryConfirmed: response.ok && parseDeliveryConfirmed(bodyText),
        responseBodyHash: `0x${createHash('sha256').update(bodyText).digest('hex')}`,
        ...(providerSignature ? { providerSignature: providerSignature as `0x${string}` } : {}),
      };
    },
  };
}

function parseDeliveryConfirmed(bodyText: string): boolean {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    return typeof parsed === 'object' && parsed !== null && (parsed as { deliveryConfirmed?: unknown }).deliveryConfirmed === true;
  } catch {
    return false;
  }
}
