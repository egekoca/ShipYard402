import { HASH_PATTERN, hashCanonical, hashText, isSuccess, type JsonValue } from './scenario-shared.js';
import type { ProtectedDeliveryAttempt, ProtectedDeliveryClient, ReplayEvidence } from './replay-runner.js';

export type InvalidCredentialScenario = Readonly<{
  scenarioId: string;
  targetServiceId: string;
  targetVersionHash: `0x${string}`;
  policyHash: `0x${string}`;
  method: 'GET' | 'POST';
  route: string;
  requestBody?: JsonValue;
  /** What to present instead of a real receipt. Empty string ('') means no receipt at all. */
  presentedReceipt?: string;
}>;

/**
 * Complements the replay check (a spent receipt can't be reused) by proving the route rejects a
 * receipt that was never valid in the first place -- either absent (presentedReceipt: '') or a
 * tampered/malformed token that fails the target's own integrity check. No real payment happens
 * in either case, so paymentProofHash/presentedReceiptHash reflect that: the zero hash and a hash
 * of whatever bogus value was actually presented, never a real payment's proof.
 */
export class InvalidCredentialRejectionRunner {
  readonly #client: ProtectedDeliveryClient;

  constructor(client: ProtectedDeliveryClient) {
    this.#client = client;
  }

  async run(scenario: InvalidCredentialScenario, signal?: AbortSignal): Promise<ReplayEvidence> {
    validateScenario(scenario);
    const presentedReceipt = scenario.presentedReceipt ?? '';
    const idempotencyKey = `${scenario.scenarioId}:invalid-credential`;
    const requestHash = hashCanonical({
      method: scenario.method,
      route: scenario.route,
      requestBody: scenario.requestBody ?? null,
      idempotencyKey,
    });

    let response: ProtectedDeliveryAttempt | undefined;
    try {
      response = await this.#client.execute({
        method: scenario.method,
        route: scenario.route,
        ...(scenario.requestBody === undefined ? {} : { requestBody: scenario.requestBody }),
        paymentReceipt: presentedReceipt,
        idempotencyKey,
        ...(signal ? { signal } : {}),
      });
      validateAttempt(response);
    } catch {
      return evidence(scenario, presentedReceipt, 'INCONCLUSIVE', 'INVALID_CREDENTIAL_PROBE_INCONCLUSIVE', [
        { phase: 'INITIAL', requestHash },
      ]);
    }

    const attempt = {
      phase: 'INITIAL' as const,
      requestHash,
      responseHash: response.responseBodyHash,
      statusCode: response.statusCode,
      deliveryConfirmed: response.deliveryConfirmed,
      ...(response.providerSignature ? { providerSignature: response.providerSignature } : {}),
    };

    if (isSuccess(response.statusCode) && response.deliveryConfirmed) {
      return evidence(scenario, presentedReceipt, 'FAIL', 'INVALID_CREDENTIAL_ACCEPTED', [attempt]);
    }
    if (response.statusCode >= 400 && response.statusCode < 500) {
      return evidence(scenario, presentedReceipt, 'PASS', undefined, [attempt]);
    }
    return evidence(scenario, presentedReceipt, 'INCONCLUSIVE', 'INVALID_CREDENTIAL_PROBE_INCONCLUSIVE', [attempt]);
  }
}

const ZERO_HASH = `0x${'0'.repeat(64)}` as const;

function evidence(
  scenario: InvalidCredentialScenario,
  presentedReceipt: string,
  result: ReplayEvidence['result'],
  failureCode: ReplayEvidence['failureCode'],
  attempts: ReplayEvidence['attempts'],
): ReplayEvidence {
  return {
    scenarioId: scenario.scenarioId,
    targetServiceId: scenario.targetServiceId,
    targetVersionHash: scenario.targetVersionHash,
    policyHash: scenario.policyHash,
    paymentProofHash: ZERO_HASH,
    presentedReceiptHash: hashText(presentedReceipt),
    result,
    ...(failureCode ? { failureCode } : {}),
    attempts,
  };
}

function validateScenario(scenario: InvalidCredentialScenario): void {
  if (!scenario.scenarioId || !scenario.targetServiceId)
    throw new Error('Invalid-credential scenario identity is required');
  const routeBase = 'https://protected-target.invalid';
  const parsedRoute = new URL(scenario.route, routeBase);
  if (
    !scenario.route.startsWith('/') ||
    parsedRoute.origin !== routeBase ||
    parsedRoute.hash ||
    /\\|%5c/i.test(scenario.route)
  ) {
    throw new Error('Invalid-credential route must be an origin-relative path');
  }
  for (const [field, value] of [
    ['targetVersionHash', scenario.targetVersionHash],
    ['policyHash', scenario.policyHash],
  ] as const) {
    if (!HASH_PATTERN.test(value)) throw new Error(`${field} must be a 32-byte hash`);
  }
}

function validateAttempt(attempt: ProtectedDeliveryAttempt): void {
  if (!Number.isInteger(attempt.statusCode) || attempt.statusCode < 100 || attempt.statusCode > 599) {
    throw new Error('Protected delivery client returned an invalid HTTP status');
  }
  if (!HASH_PATTERN.test(attempt.responseBodyHash)) {
    throw new Error('Protected delivery client returned an invalid response hash');
  }
}
