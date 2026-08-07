import { createHash, randomUUID } from 'node:crypto';

import { flowRuntimeCapabilitySchema, type FlowRuntimeCapability } from '@shipyard402/goat-network-config';
import { parseAtomicAmount } from '@shipyard402/run-domain';
import { z } from 'zod';

const bytes32Schema = z.string().regex(/^0x[a-fA-F0-9]{64}$/);
const atomicAmountSchema = z.string().regex(/^(0|[1-9]\d*)$/);
const httpsUrlSchema = z.string().url().refine((value) => new URL(value).protocol === 'https:', 'HTTPS is required');

export const quoteRequestSchema = z
  .object({
    organizationId: z.string().uuid(),
    requesterAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    targetAgentId: z.string().min(1).max(256),
    targetServiceId: z.string().min(1).max(256),
    targetVersionHash: bytes32Schema,
    previousVersionHash: bytes32Schema.optional(),
    policyHash: bytes32Schema,
    x402Endpoint: httpsUrlSchema,
    openApiUrl: httpsUrlSchema,
    maximumCustomerBudgetAtomic: atomicAmountSchema,
  })
  .strict();

export type QuoteRequest = z.infer<typeof quoteRequestSchema>;

export type QuotePricingPolicy = Readonly<{
  pricingStatus: 'HYPOTHESIS';
  /**
   * Shipyard's take rate, in basis points (500 = 5%), applied to the sum of the pass-through
   * cost line items below -- not a flat fee. A flat fee overcharges a cheap run and undercharges
   * an expensive one; a take rate scales with what the run actually costs to operate.
   */
  feeRateBps: number;
  mandatoryToolBudgetAtomic: string;
  dynamicToolBudgetAtomic: string;
  modelInfrastructureReserveAtomic: string;
  chainStorageReserveAtomic: string;
  riskSupportReserveAtomic: string;
  quoteTtlSeconds: number;
}>;

export const quoteSchema = z
  .object({
    id: z.string().min(8).max(200),
    request: quoteRequestSchema,
    capabilitySnapshot: flowRuntimeCapabilitySchema,
    pricingStatus: z.literal('HYPOTHESIS'),
    lineItems: z.object({
      baseOrchestrationFeeAtomic: atomicAmountSchema,
      mandatoryToolBudgetAtomic: atomicAmountSchema,
      dynamicToolBudgetAtomic: atomicAmountSchema,
      modelInfrastructureReserveAtomic: atomicAmountSchema,
      chainStorageReserveAtomic: atomicAmountSchema,
      riskSupportReserveAtomic: atomicAmountSchema,
    }).strict(),
    totalAtomicAmount: atomicAmountSchema,
    refundableToolBudgetAtomic: atomicAmountSchema,
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    quoteCommitment: bytes32Schema,
  })
  .strict();

export type Quote = z.infer<typeof quoteSchema>;

export class QuoteBudgetExceededError extends Error {
  constructor(total: string, maximum: string) {
    super(`Quote total ${total} exceeds customer maximum budget ${maximum}`);
    this.name = 'QuoteBudgetExceededError';
  }
}

export class QuoteEngine {
  readonly #pricing: QuotePricingPolicy;
  readonly #idFactory: () => string;

  constructor(pricing: QuotePricingPolicy, idFactory: () => string = randomUUID) {
    this.#pricing = validatePricing(pricing);
    this.#idFactory = idFactory;
  }

  createQuote(input: QuoteRequest, capability: FlowRuntimeCapability, now: Date): Quote {
    const request = quoteRequestSchema.parse(input);
    const passThroughCosts = {
      mandatoryToolBudgetAtomic: this.#pricing.mandatoryToolBudgetAtomic,
      dynamicToolBudgetAtomic: this.#pricing.dynamicToolBudgetAtomic,
      modelInfrastructureReserveAtomic: this.#pricing.modelInfrastructureReserveAtomic,
      chainStorageReserveAtomic: this.#pricing.chainStorageReserveAtomic,
      riskSupportReserveAtomic: this.#pricing.riskSupportReserveAtomic,
    };
    const passThroughTotal = Object.values(passThroughCosts).reduce((sum, value) => sum + parseAtomicAmount(value), 0n);
    // Solving fee / (fee + passThroughTotal) = feeRateBps / 10_000 for fee.
    const feeAtomic = (passThroughTotal * BigInt(this.#pricing.feeRateBps)) / BigInt(10_000 - this.#pricing.feeRateBps);
    const lineItems = {
      baseOrchestrationFeeAtomic: feeAtomic.toString(),
      ...passThroughCosts,
    };
    const total = passThroughTotal + feeAtomic;
    if (total > parseAtomicAmount(request.maximumCustomerBudgetAtomic)) {
      throw new QuoteBudgetExceededError(total.toString(), request.maximumCustomerBudgetAtomic);
    }

    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + this.#pricing.quoteTtlSeconds * 1_000).toISOString();
    const unsigned = {
      id: `quote_${this.#idFactory()}`,
      request,
      capabilitySnapshot: capability,
      pricingStatus: this.#pricing.pricingStatus,
      lineItems,
      totalAtomicAmount: total.toString(),
      refundableToolBudgetAtomic: (
        parseAtomicAmount(lineItems.mandatoryToolBudgetAtomic) +
        parseAtomicAmount(lineItems.dynamicToolBudgetAtomic)
      ).toString(),
      createdAt,
      expiresAt,
    } as const;

    return {
      ...unsigned,
      quoteCommitment: `0x${createHash('sha256').update(canonicalJson(unsigned)).digest('hex')}`,
    };
  }
}

function validatePricing(pricing: QuotePricingPolicy): QuotePricingPolicy {
  for (const [key, value] of Object.entries(pricing)) {
    if (key.endsWith('Atomic')) parseAtomicAmount(String(value));
  }
  if (!Number.isInteger(pricing.feeRateBps) || pricing.feeRateBps <= 0 || pricing.feeRateBps >= 10_000) {
    throw new Error('Fee rate must be an integer number of basis points strictly between 0 and 10000');
  }
  if (!Number.isInteger(pricing.quoteTtlSeconds) || pricing.quoteTtlSeconds < 60 || pricing.quoteTtlSeconds > 86_400) {
    throw new Error('Quote TTL must be between 60 seconds and 24 hours');
  }
  return Object.freeze({ ...pricing });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}
