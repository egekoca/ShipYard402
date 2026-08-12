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
      const paymentHeaderName = input.paymentHeaderName ?? 'x-payment';
      const paymentHeaders = input.paymentReceipt ? { [paymentHeaderName]: input.paymentReceipt } : {};
      const response = await fetchImpl(new URL(input.route, baseUrl), {
        method: input.method,
        headers: {
          'content-type': 'application/json',
          // The credential is the x402 `X-PAYMENT` header (a signed EIP-3009 authorization). The
          // replay attack works by presenting the byte-identical header twice.
          ...paymentHeaders,
          'x-idempotency-key': input.idempotencyKey,
        },
        ...(input.requestBody === undefined ? {} : { body: JSON.stringify(input.requestBody) }),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const bodyText = await response.text();
      const providerSignature = captureProviderSignature ? response.headers.get('x-provider-signature') : null;
      const settlementTransactionHash = parseSettlementTransactionHash(response.headers);

      return {
        statusCode: response.status,
        deliveryConfirmed: response.ok && parseDeliveryConfirmed(bodyText),
        responseBodyHash: `0x${createHash('sha256').update(bodyText).digest('hex')}`,
        ...(providerSignature ? { providerSignature: providerSignature as `0x${string}` } : {}),
        ...(settlementTransactionHash ? { settlementTransactionHash } : {}),
      };
    },
  };
}

function parseSettlementTransactionHash(headers: Headers): `0x${string}` | null {
  for (const name of ['payment-response', 'x-payment-response']) {
    const encoded = headers.get(name);
    if (!encoded) continue;
    try {
      const parsed: unknown = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      if (typeof parsed !== 'object' || parsed === null) continue;
      const record = parsed as Record<string, unknown>;
      const value = record['transaction'] ?? record['transactionHash'];
      if (typeof value === 'string' && /^0x[a-fA-F0-9]{64}$/.test(value)) return value as `0x${string}`;
    } catch {
      // A malformed settlement header is treated as absent and can never become evidence of pay.
    }
  }
  return null;
}

function parseDeliveryConfirmed(bodyText: string): boolean {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as { deliveryConfirmed?: unknown }).deliveryConfirmed === true
    );
  } catch {
    return false;
  }
}
