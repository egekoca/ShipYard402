import { isIP } from 'node:net';

import { z } from 'zod';

const atomicAmountSchema = z.string().regex(/^(0|[1-9]\d*)$/, 'Must be an unsigned atomic amount');
const toolAgentIdSchema = z.string().min(1).max(256);
const scenarioIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_.-]{1,127}$/);

export const runMandateSchema = z
  .object({
    maximumTotalSpend: atomicAmountSchema,
    maximumSinglePurchase: atomicAmountSchema,
    maximumToolCalls: z.number().int().min(1).max(100),
    maximumRetriesPerTool: z.number().int().min(0).max(5),
    allowedToolAgentIds: z.array(toolAgentIdSchema).min(1).max(100),
    allowedHosts: z.array(z.string().transform(canonicalizeHost)).min(1).max(100),
    requiredScenarios: z.array(scenarioIdSchema).min(1).max(100),
    additionalSpendApprovalThreshold: atomicAmountSchema,
    deadline: z.number().int().positive(),
  })
  .strict()
  .superRefine((mandate, context) => {
    if (BigInt(mandate.maximumSinglePurchase) > BigInt(mandate.maximumTotalSpend)) {
      context.addIssue({
        code: 'custom',
        path: ['maximumSinglePurchase'],
        message: 'Single purchase limit cannot exceed total spend limit',
      });
    }
    if (BigInt(mandate.additionalSpendApprovalThreshold) > BigInt(mandate.maximumTotalSpend)) {
      context.addIssue({
        code: 'custom',
        path: ['additionalSpendApprovalThreshold'],
        message: 'Approval threshold cannot exceed total spend limit',
      });
    }
    assertUnique(mandate.allowedToolAgentIds, 'allowedToolAgentIds', context);
    assertUnique(mandate.allowedHosts, 'allowedHosts', context);
    assertUnique(mandate.requiredScenarios, 'requiredScenarios', context);

    for (const [index, host] of mandate.allowedHosts.entries()) {
      if (isForbiddenHost(host)) {
        context.addIssue({
          code: 'custom',
          path: ['allowedHosts', index],
          message: 'Loopback, link-local, metadata and private network hosts are forbidden',
        });
      }
    }
  });

export type RunMandate = z.infer<typeof runMandateSchema>;

export function canonicalizeHost(input: string): string {
  const value = input.trim().toLowerCase().replace(/\.$/, '');
  if (value.length === 0 || value.includes('/') || value.includes('@') || value.includes(':')) {
    throw new Error('allowedHosts entries must be bare DNS hostnames');
  }
  return value;
}
export function isForbiddenHost(host: string): boolean {
  const canonical = host.trim().toLowerCase().replace(/\.$/, '');
  if (
    canonical === 'localhost' ||
    canonical.endsWith('.localhost') ||
    canonical === 'metadata.google.internal' ||
    canonical === '169.254.169.254'
  ) {
    return true;
  }

  const ipVersion = isIP(canonical);
  if (ipVersion === 4) return isForbiddenIpv4(canonical);
  if (ipVersion === 6) {
    return canonical === '::1' || canonical === '::' || canonical.startsWith('fc') || canonical.startsWith('fd') || canonical.startsWith('fe80:');
  }
  return false;
}

function isForbiddenIpv4(ip: string): boolean {
  const octets = ip.split('.').map(Number);
  const first = octets[0] ?? 0;
  const second = octets[1] ?? 0;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    first >= 224
  );
}

function assertUnique(
  values: readonly string[],
  path: string,
  context: z.RefinementCtx,
): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: 'custom', path: [path], message: 'Values must be unique' });
  }
}
