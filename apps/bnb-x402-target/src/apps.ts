import { createHash } from 'node:crypto';

import { x402Facilitator } from '@x402/core/facilitator';
import { HTTPFacilitatorClient, x402ResourceServer } from '@x402/core/server';
import type { Network, PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { ExactEvmScheme as FacilitatorExactEvmScheme } from '@x402/evm/exact/facilitator';
import { ExactEvmScheme as ServerExactEvmScheme } from '@x402/evm/exact/server';
import type { FacilitatorEvmSigner } from '@x402/evm';
import { paymentMiddleware } from '@x402/fastify';
import Fastify, { type FastifyInstance } from 'fastify';

import { assertControlledBnbRequirement } from './requirement-policy.js';
import { BNB_MAINNET_NETWORK, type BnbX402RuntimeConfig } from './runtime-config.js';

type FacilitatorBody = Readonly<{
  paymentPayload?: unknown;
  paymentRequirements?: unknown;
}>;

export function createControlledBnbFacilitatorApp(
  config: Pick<BnbX402RuntimeConfig, 'payTo' | 'priceAtomic' | 'settlementAsset'>,
  signer: FacilitatorEvmSigner,
): FastifyInstance {
  const app = Fastify({ logger: true, bodyLimit: 256 * 1024 });
  const verifiedPayments = new Map<string, number>();
  const facilitator = new x402Facilitator().register(
    BNB_MAINNET_NETWORK as Network,
    new FacilitatorExactEvmScheme(signer),
  );

  facilitator
    .onAfterVerify(async (context) => {
      if (context.result.isValid) verifiedPayments.set(paymentHash(context.paymentPayload), Date.now());
    })
    .onBeforeSettle(async (context) => {
      const hash = paymentHash(context.paymentPayload);
      const verifiedAt = verifiedPayments.get(hash);
      if (!verifiedAt) return { abort: true, reason: 'Payment must be verified before settlement' };
      if (Date.now() - verifiedAt > 5 * 60_000) {
        verifiedPayments.delete(hash);
        return { abort: true, reason: 'Payment verification expired' };
      }
      return undefined;
    })
    .onAfterSettle(async (context) => {
      verifiedPayments.delete(paymentHash(context.paymentPayload));
    })
    .onSettleFailure(async (context) => {
      verifiedPayments.delete(paymentHash(context.paymentPayload));
    });

  app.post<{ Body: FacilitatorBody }>('/verify', async (request, reply) => {
    const { paymentPayload, paymentRequirements } = requireFacilitatorBody(request.body);
    assertControlledBnbRequirement(paymentRequirements, config);
    return reply.send(
      await facilitator.verify(paymentPayload as PaymentPayload, paymentRequirements as PaymentRequirements),
    );
  });

  app.post<{ Body: FacilitatorBody }>('/settle', async (request, reply) => {
    const { paymentPayload, paymentRequirements } = requireFacilitatorBody(request.body);
    assertControlledBnbRequirement(paymentRequirements, config);
    return reply.send(
      await facilitator.settle(paymentPayload as PaymentPayload, paymentRequirements as PaymentRequirements),
    );
  });

  app.get('/supported', async () => facilitator.getSupported());
  app.get('/health', async () => ({
    status: 'ok',
    network: BNB_MAINNET_NETWORK,
    asset: config.settlementAsset,
    transferMethod: 'permit2',
    protocolVersion: 2,
  }));
  return app;
}

export function createControlledBnbTargetApp(
  config: Pick<
    BnbX402RuntimeConfig,
    'facilitatorHost' | 'facilitatorPort' | 'payTo' | 'priceAtomic' | 'settlementAsset'
  >,
): FastifyInstance {
  const app = Fastify({ logger: true });
  const facilitatorUrl = `http://${config.facilitatorHost}:${config.facilitatorPort}`;
  const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: facilitatorUrl }));
  resourceServer.register('eip155:*', new ServerExactEvmScheme());

  paymentMiddleware(
    app,
    {
      'GET /paid/resource': {
        accepts: {
          scheme: 'exact',
          network: BNB_MAINNET_NETWORK,
          payTo: config.payTo,
          price: {
            amount: config.priceAtomic,
            asset: config.settlementAsset,
            extra: { assetTransferMethod: 'permit2' },
          },
        },
      },
    },
    resourceServer,
  );

  app.get('/paid/resource', async () => ({
    deliveryConfirmed: true,
    network: BNB_MAINNET_NETWORK,
    asset: config.settlementAsset,
    transferMethod: 'permit2',
    deliveredAt: new Date().toISOString(),
  }));
  app.get('/health', async () => ({
    status: 'ok',
    network: BNB_MAINNET_NETWORK,
    asset: config.settlementAsset,
    priceAtomic: config.priceAtomic,
    protocolVersion: 2,
    facilitator: 'self-hosted',
  }));
  return app;
}

function requireFacilitatorBody(body: FacilitatorBody): Required<FacilitatorBody> {
  if (!body?.paymentPayload || !body.paymentRequirements) {
    throw new Error('paymentPayload and paymentRequirements are required');
  }
  return { paymentPayload: body.paymentPayload, paymentRequirements: body.paymentRequirements };
}

function paymentHash(payload: PaymentPayload): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
