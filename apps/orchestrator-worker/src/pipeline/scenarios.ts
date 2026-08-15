import {
  InvalidCredentialRejectionRunner,
  ProtectedDeliveryReplayRunner,
  verifyResponseSignature,
  type ReplayEvidence,
  type ReplayScenario,
} from '@shipyard402/protected-delivery-runner';
import { keccak256, toUtf8Bytes } from 'ethers';

import type { ScenarioExecutionContext, ScenarioResult } from './types.js';

export const PAID_RESOURCE_ROUTE = '/paid/resource';
export const ZERO_CHAIN_TRANSACTION_HASH = `0x${'0'.repeat(64)}` as const;

/**
 * What the pipeline can actually run, keyed by scenario ID. compileTestPlan's output can contain
 * IDs beyond this set (the AI proposes freely, see risk-classifier's availableScenarios prompt
 * field) -- those are skipped, not executed, since there is nothing registered to run them.
 */
export const SCENARIO_EXECUTORS: Readonly<Record<string, (ctx: ScenarioExecutionContext) => Promise<ScenarioResult>>> =
  {
    'payment-proof-replay': async (ctx) => {
      const scenario: ReplayScenario = {
        scenarioId: 'payment-proof-replay',
        targetServiceId: ctx.targetServiceId,
        targetVersionHash: ctx.targetVersionHash,
        policyHash: ctx.policyHash,
        method: 'GET',
        route: ctx.route,
        paymentReceipt: ctx.paymentReceipt,
        paymentHeaderName: ctx.paymentHeaderName,
        paymentProofHash: keccak256(toUtf8Bytes(ctx.paymentTransactionHash)) as `0x${string}`,
      };
      const replayEvidence = await new ProtectedDeliveryReplayRunner(ctx.deliveryClient).run(scenario);
      const settlementTransactionHash = replayEvidence.attempts.find(
        (attempt) => attempt.settlementTransactionHash,
      )?.settlementTransactionHash;
      return {
        evidence: replayEvidence,
        chainTransactionHash: settlementTransactionHash ?? ctx.paymentTransactionHash,
      };
    },
    'unpaid-access-denial': async (ctx) => ({
      evidence: await new InvalidCredentialRejectionRunner(ctx.deliveryClient).run({
        scenarioId: 'unpaid-access-denial',
        targetServiceId: ctx.targetServiceId,
        targetVersionHash: ctx.targetVersionHash,
        policyHash: ctx.policyHash,
        method: 'GET',
        route: ctx.route,
        paymentHeaderName: ctx.paymentHeaderName,
      }),
      // No payment happens in this scenario, so there is no real transaction to attach the receipt to.
      chainTransactionHash: ZERO_CHAIN_TRANSACTION_HASH,
    }),
    'tampered-receipt-rejection': async (ctx) => ({
      evidence: await new InvalidCredentialRejectionRunner(ctx.deliveryClient).run({
        scenarioId: 'tampered-receipt-rejection',
        targetServiceId: ctx.targetServiceId,
        targetVersionHash: ctx.targetVersionHash,
        policyHash: ctx.policyHash,
        method: 'GET',
        route: ctx.route,
        paymentHeaderName: ctx.paymentHeaderName,
        // Deterministically corrupt the real earned receipt -- guaranteed to fail the target's
        // integrity check without needing to know its internal format.
        presentedReceipt: `${ctx.paymentReceipt}-tampered`,
      }),
      // No new payment -- this reuses (a corrupted form of) the same receipt from procurement.
      chainTransactionHash: ZERO_CHAIN_TRANSACTION_HASH,
    }),
  };

/**
 * Reduces a run's scenario evidence to one verdict. A PASS is a positive claim -- "we attacked the
 * payment logic and it held" -- so it is only ever returned when there is evidence to back it.
 * An empty set is INCONCLUSIVE, never PASS: a run that produced no scenario at all (procurement
 * exhausted its budget, the pipeline was finalized after a terminal failure) has demonstrated
 * nothing about the target, and reporting that as PASS would sell a verdict nobody earned.
 */
export function aggregateScenarioResult(results: readonly ReplayEvidence[]): 'PASS' | 'FAIL' | 'INCONCLUSIVE' {
  if (results.length === 0) return 'INCONCLUSIVE';
  if (results.some((result) => result.result === 'FAIL')) return 'FAIL';
  if (results.some((result) => result.result === 'INCONCLUSIVE')) return 'INCONCLUSIVE';
  return 'PASS';
}

/**
 * Opt-in cross-check: if the provider is registered to sign its responses (DemoTargetConfig.
 * providerSignerAddress), a PASS is only trustworthy if every attempt with a real response is
 * actually signed by that address -- otherwise a compromised or buggy fetch client could fabricate
 * "the target rejected the replay" without ever really talking to the target. A FAIL is left as-is:
 * the practical risk this guards against is a forged PASS hiding a real vulnerability, not a forged
 * FAIL hiding a real pass (nothing is gained by fabricating a worse result).
 */
export function verifyScenarioProvenance(
  results: readonly ScenarioResult[],
  expectedSigner: `0x${string}` | undefined,
): readonly ScenarioResult[] {
  if (!expectedSigner) return results;
  return results.map((result) => {
    if (result.evidence.result !== 'PASS') return result;
    const unverified = result.evidence.attempts.some(
      (attempt) =>
        attempt.responseHash !== undefined &&
        !verifyResponseSignature(attempt.responseHash, attempt.providerSignature, expectedSigner),
    );
    if (!unverified) return result;
    return {
      ...result,
      evidence: { ...result.evidence, result: 'INCONCLUSIVE', failureCode: 'PROVIDER_SIGNATURE_INVALID' },
    };
  });
}
