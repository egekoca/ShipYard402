import { HASH_PATTERN, hashCanonical, hashText, isSuccess, type JsonValue } from './scenario-shared.js';
import type { ProtectedDeliveryAttempt, ProtectedDeliveryClient, ReplayEvidence } from './replay-runner.js';

export type UnpaidAccessScenario = Readonly<{
  scenarioId: string;
  targetServiceId: string;
  targetVersionHash: `0x${string}`;
  policyHash: `0x${string}`;
  method: 'GET' | 'POST';
  route: string;
  requestBody?: JsonValue;
}>;

/**
 * Complements the replay check: replay proves a spent receipt can't be reused, this proves the
 * route can't be reached with no receipt at all. No payment happens in this scenario, so
 * paymentProofHash/presentedReceiptHash are the zero hash / hash of empty string rather than
 * derived from a real payment — there is none to derive them from.
 */
export class UnpaidAccessDenialRunner {
  readonly #client: ProtectedDeliveryClient;

  constructor(client: ProtectedDeliveryClient) {
    this.#client = client;
  }

  async run(scenario: UnpaidAccessScenario, signal?: AbortSignal): Promise<ReplayEvidence> {
    validateScenario(scenario);
    const idempotencyKey = `${scenario.scenarioId}:unpaid`;
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
        paymentReceipt: '',
        idempotencyKey,
        ...(signal ? { signal } : {}),
      });
      validateAttempt(response);
    } catch {
      return evidence(scenario, 'INCONCLUSIVE', 'UNPAID_ACCESS_PROBE_INCONCLUSIVE', [{ phase: 'INITIAL', requestHash }]);
    }

    const attempt = {
      phase: 'INITIAL' as const,
      requestHash,
      responseHash: response.responseBodyHash,
      statusCode: response.statusCode,
      deliveryConfirmed: response.deliveryConfirmed,
    };

    if (isSuccess(response.statusCode) && response.deliveryConfirmed) {
      return evidence(scenario, 'FAIL', 'UNPAID_ACCESS_ACCEPTED', [attempt]);
    }
    if (response.statusCode >= 400 && response.statusCode < 500) {
      return evidence(scenario, 'PASS', undefined, [attempt]);
    }
    return evidence(scenario, 'INCONCLUSIVE', 'UNPAID_ACCESS_PROBE_INCONCLUSIVE', [attempt]);
  }
}

const ZERO_HASH = `0x${'0'.repeat(64)}` as const;

function evidence(
  scenario: UnpaidAccessScenario,
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
    presentedReceiptHash: hashText(''),
    result,
    ...(failureCode ? { failureCode } : {}),
    attempts,
  };
}

function validateScenario(scenario: UnpaidAccessScenario): void {
  if (!scenario.scenarioId || !scenario.targetServiceId) throw new Error('Unpaid-access scenario identity is required');
  const routeBase = 'https://protected-target.invalid';
  const parsedRoute = new URL(scenario.route, routeBase);
  if (
    !scenario.route.startsWith('/') ||
    parsedRoute.origin !== routeBase ||
    parsedRoute.hash ||
    /\\|%5c/i.test(scenario.route)
  ) {
    throw new Error('Unpaid-access route must be an origin-relative path');
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
