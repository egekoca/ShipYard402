import {
  buildExactEvmRequirements,
  decodePaymentHeader,
  verifyExactEvmPayment,
  X402_VERSION,
  type ExactEvmRequirements,
} from '@shipyard402/x402-payments';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import { createProviderSigner, signResponseBody } from './provider-signing.js';
import { SettlementError, type X402Settler } from './settler.js';

export type DemoTargetMode = 'V1_VULNERABLE' | 'V2_PROTECTED';

const PAID_RESOURCE_ROUTE = '/paid/resource';
const PAYMENT_HEADER = 'x-payment';
const PAYMENT_RESPONSE_HEADER = 'x-payment-response';
const PROVIDER_SIGNATURE_HEADER = 'x-provider-signature';

/**
 * What this demo target charges for, and how a payer must pay it. These are exactly the fields a
 * real x402 `exact` resource server advertises in its 402 body: the settlement asset (an EIP-3009
 * ERC-20), the price, the recipient, and the token's EIP-712 domain so the payer can reproduce the
 * digest the token will accept. `settler` is how the server moves the money once a payment verifies.
 */
export type PaymentConfig = Readonly<{
  chainId: number;
  asset: `0x${string}`;
  payTo: `0x${string}`;
  amountAtomic: string;
  tokenName: string;
  tokenVersion: string;
  maxTimeoutSeconds?: number;
  settler: X402Settler;
}>;

export type DemoTargetOptions = Readonly<{
  mode: DemoTargetMode;
  payment: PaymentConfig;
  now?: () => Date;
  /** When set, every /paid/resource response carries an x-provider-signature header. */
  providerSignerPrivateKey?: `0x${string}`;
}>;

/**
 * A real x402 `exact` resource server, in two modes that differ only in how they treat settlement:
 *
 * - `V2_PROTECTED` settles every verified payment on-chain synchronously and delivers only if the
 *   settlement succeeds. Because the EIP-3009 token consumes the authorization nonce, a replayed
 *   payment's settlement reverts, so the replay is never delivered.
 * - `V1_VULNERABLE` delivers as soon as the payment *signature* verifies, treating settlement as
 *   best-effort. This is a real, common x402 implementation mistake -- trusting the payment header
 *   without requiring the money to actually move -- and it lets a replayed X-PAYMENT be delivered
 *   a second time even though its on-chain settlement reverts.
 *
 * Everything else (the 402 challenge, EIP-712 signature verification, forged/unpaid rejection) is
 * identical between the two, so a run isolates exactly the settlement-trust bug.
 */
export function createDemoTargetApp(options: DemoTargetOptions): FastifyInstance {
  const now = options.now ?? (() => new Date());
  const nowSeconds = () => Math.floor(now().getTime() / 1_000);
  const providerSigner = options.providerSignerPrivateKey
    ? createProviderSigner(options.providerSignerPrivateKey)
    : undefined;
  const app = Fastify({ logger: { level: process.env['NODE_ENV'] === 'test' ? 'silent' : 'info' } });

  // Every delivered request costs the settler real gas: it submits the payer's authorization
  // on-chain before it answers. Without a ceiling, anyone holding the (freely mintable, valueless)
  // test token can drain the settler's balance one paid call at a time, which on a public
  // deployment is a free denial-of-service against the whole demo. The limit is deliberately
  // generous -- a real run makes a handful of calls -- and the plugin is awaited via `after` for
  // the same onRoute reason the gateway documents.
  void app.register(rateLimit, {
    max: 60,
    timeWindow: '1 minute',
    errorResponseBuilder: (_request, context) => ({
      statusCode: 429,
      code: 'RATE_LIMITED',
      message: `Rate limit exceeded, retry in ${context.after}.`,
    }),
  });

  function requirementsFor(request: FastifyRequest): ExactEvmRequirements {
    const resource = `${request.protocol}://${request.host}${PAID_RESOURCE_ROUTE}`;
    return buildExactEvmRequirements({
      chainId: options.payment.chainId,
      amountAtomic: options.payment.amountAtomic,
      resource,
      payTo: options.payment.payTo,
      asset: options.payment.asset,
      tokenName: options.payment.tokenName,
      tokenVersion: options.payment.tokenVersion,
      description: 'Shipyard x402 demo target paid resource',
      ...(options.payment.maxTimeoutSeconds === undefined
        ? {}
        : { maxTimeoutSeconds: options.payment.maxTimeoutSeconds }),
    });
  }

  async function reply402(
    reply: FastifyReply,
    requirements: ExactEvmRequirements,
    error: string,
    failureCodes?: readonly string[],
  ): Promise<void> {
    // The 402 body is the payment challenge itself: a conformant x402 client reads `accepts` to
    // learn what to pay. `error`/`failureCodes` are advisory, for humans and for evidence.
    await send(reply, 402, {
      x402Version: X402_VERSION,
      accepts: [requirements],
      error,
      ...(failureCodes && failureCodes.length > 0 ? { failureCodes } : {}),
    });
  }

  async function send(reply: FastifyReply, statusCode: number, payload: unknown): Promise<void> {
    const bodyText = JSON.stringify(payload);
    if (providerSigner) {
      reply.header(PROVIDER_SIGNATURE_HEADER, await signResponseBody(providerSigner, bodyText));
    }
    await reply.status(statusCode).type('application/json').send(bodyText);
  }

  // Declared inside `after` so the rate-limit plugin above has finished loading first. A route
  // registered before that plugin attaches its hooks silently gets no limiting at all -- the
  // api-gateway documents the same trap.
  app.after(() => {
    app.get('/health', async () => ({ status: 'ok', mode: options.mode }));

    /**
     * The service's own OpenAPI document. Shipyard's onboarding hashes exactly these bytes into the
     * release's `targetVersionHash`, so a target that changes its advertised surface produces a
     * different version and therefore needs its own run.
     */
    app.get('/openapi.json', async () => ({
      openapi: '3.1.0',
      info: {
        title: 'Shipyard x402 demo target',
        version: '0.1.0',
        description: 'A paid resource protected by the x402 `exact` scheme, used to exercise release runs.',
      },
      paths: {
        [PAID_RESOURCE_ROUTE]: {
          get: {
            summary: 'Paid resource',
            responses: {
              '200': { description: 'Delivered after a settled x402 payment.' },
              '402': { description: 'Payment required; the body carries the x402 requirements.' },
            },
          },
        },
      },
    }));

    app.route({
      method: ['GET', 'POST'],
      url: PAID_RESOURCE_ROUTE,
      handler: async (request, reply) => {
        const requirements = requirementsFor(request);

        const rawHeader = request.headers[PAYMENT_HEADER];
        const encoded = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
        if (!encoded) {
          return reply402(reply, requirements, 'PAYMENT_REQUIRED');
        }

        const header = decodePaymentHeader(encoded);
        if (!header) {
          return reply402(reply, requirements, 'MALFORMED_PAYMENT_HEADER');
        }

        const verification = await verifyExactEvmPayment({ header, requirements, nowSec: nowSeconds() });
        if (!verification.valid) {
          return reply402(reply, requirements, 'INVALID_PAYMENT', verification.failureCodes);
        }

        if (options.mode === 'V2_PROTECTED') {
          // Settle first; deliver only if the money actually moved. A replayed authorization reverts
          // at the token (nonce already consumed) and is surfaced as 409, never delivered.
          let settlementHash: `0x${string}`;
          try {
            const settlement = await options.payment.settler.settle(header.payload);
            settlementHash = settlement.transactionHash;
          } catch (error) {
            if (error instanceof SettlementError && error.code === 'ALREADY_SETTLED') {
              return reply402Conflict(reply, 'PAYMENT_ALREADY_SETTLED');
            }
            return reply402(reply, requirements, 'SETTLEMENT_FAILED', [
              error instanceof SettlementError ? error.code : 'SETTLEMENT_UNAVAILABLE',
            ]);
          }
          reply.header(PAYMENT_RESPONSE_HEADER, encodeSettlementResponse(settlementHash));
        } else {
          // V1_VULNERABLE: the bug. Deliver on a valid signature, treating settlement as best-effort.
          // The first payment still settles; a replay's settlement reverts, but we swallow it and
          // deliver anyway -- so the same X-PAYMENT is honored twice.
          try {
            const settlement = await options.payment.settler.settle(header.payload);
            reply.header(PAYMENT_RESPONSE_HEADER, encodeSettlementResponse(settlement.transactionHash));
          } catch {
            /* swallowed on purpose -- delivering without requiring settlement is the vulnerability */
          }
        }

        return send(reply, 200, {
          deliveryConfirmed: true,
          resource: PAID_RESOURCE_ROUTE,
          // The authorization nonce is the payment's unique id -- useful in evidence for correlating a
          // delivery with the exact payment that (should have) paid for it.
          orderId: header.payload.authorization.nonce,
          deliveredAt: now().toISOString(),
        });
      },
    });

    async function reply402Conflict(reply: FastifyReply, error: string): Promise<void> {
      await send(reply, 409, { error });
    }
  });

  return app;
}

/** The `X-PAYMENT-RESPONSE` header value: a small JSON receipt of where the payment settled. */
function encodeSettlementResponse(transactionHash: `0x${string}`): string {
  return Buffer.from(JSON.stringify({ settled: true, transactionHash }), 'utf8').toString('base64');
}

export { PAID_RESOURCE_ROUTE, PAYMENT_HEADER, PAYMENT_RESPONSE_HEADER };
