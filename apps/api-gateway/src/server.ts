import { flowRuntimeCapabilitySchema, type FlowRuntimeCapability } from '@shipyard402/goat-network-config';
import { QuoteEngine } from '@shipyard402/quote-engine';

import { createApp, type RuntimeCapabilityProvider } from './app.js';
import { InMemoryQuoteRepository, InMemoryRunRepository } from './repositories.js';

class EnvironmentCapabilityProvider implements RuntimeCapabilityProvider {
  async getShipyardMerchantCapability(): Promise<FlowRuntimeCapability | null> {
    const candidate = {
      environment: 'mainnet',
      merchantId: process.env['GOAT_FLOW_MERCHANT_ID'],
      mode: 'ERC20_DIRECT',
      chainId: 2345,
      tokenAddress: process.env['GOAT_FLOW_TOKEN_ADDRESS'],
      tokenSymbol: process.env['GOAT_FLOW_TOKEN_SYMBOL'],
      tokenDecimals: Number(process.env['GOAT_FLOW_TOKEN_DECIMALS']),
      receivingAddress: process.env['GOAT_FLOW_RECEIVING_ADDRESS'],
      minimumAtomicAmount: process.env['GOAT_FLOW_MINIMUM_ATOMIC_AMOUNT'],
      maximumAtomicAmount: process.env['GOAT_FLOW_MAXIMUM_ATOMIC_AMOUNT'],
      discoveredAt: new Date().toISOString(),
      source: 'PORTAL_REVIEW',
    };
    const parsed = flowRuntimeCapabilitySchema.safeParse(candidate);
    return parsed.success ? parsed.data : null;
  }
}

if (process.env['APP_ENV'] === 'production') {
  throw new Error('Production boot is disabled until PostgreSQL repositories and real GOAT Flow adapters are configured.');
}

const app = createApp({
  allowedWebOrigins: (process.env['WEB_ORIGIN'] ?? 'http://127.0.0.1:3000')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  capabilityProvider: new EnvironmentCapabilityProvider(),
  quoteEngine: new QuoteEngine({
    pricingStatus: 'HYPOTHESIS',
    baseOrchestrationFeeAtomic: '2000000',
    mandatoryToolBudgetAtomic: '1200000',
    dynamicToolBudgetAtomic: '600000',
    modelInfrastructureReserveAtomic: '350000',
    chainStorageReserveAtomic: '150000',
    riskSupportReserveAtomic: '400000',
    quoteTtlSeconds: 900,
  }),
  quoteRepository: new InMemoryQuoteRepository(),
  runRepository: new InMemoryRunRepository(),
});

const port = Number(process.env['PORT'] ?? 3001);
await app.listen({ host: '127.0.0.1', port });
