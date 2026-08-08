import { createHash } from 'node:crypto';

import type { ProtectedDeliveryAttempt, ProtectedDeliveryClient } from './replay-runner.js';

export type ProtectedDeliveryFetchOptions = Readonly<{
  fetchImpl?: typeof fetch;
  captureProviderSignature?: boolean;
}>;

export function createFetchProtectedDeliveryClient(
  baseUrl: string,
  options: ProtectedDeliveryFetchOptions = {},
): ProtectedDeliveryClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const captureProviderSignature = options.captureProviderSignature ?? false;

  return {
    async execute(input): Promise<ProtectedDeliveryAttempt> {
      const response = await fetchImpl(new URL(input.route, baseUrl), {
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
      const providerSignature = captureProviderSignature ? response.headers.get('x-provider-signature') : null;

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
