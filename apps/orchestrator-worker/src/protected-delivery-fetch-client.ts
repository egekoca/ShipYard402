import { createHash } from 'node:crypto';

import type { ProtectedDeliveryAttempt, ProtectedDeliveryClient } from '@shipyard402/protected-delivery-runner';

export function createFetchProtectedDeliveryClient(baseUrl: string): ProtectedDeliveryClient {
  return {
    async execute(input): Promise<ProtectedDeliveryAttempt> {
      const response = await fetch(new URL(input.route, baseUrl), {
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

      return {
        statusCode: response.status,
        deliveryConfirmed: response.ok && parseDeliveryConfirmed(bodyText),
        responseBodyHash: `0x${createHash('sha256').update(bodyText).digest('hex')}`,
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
