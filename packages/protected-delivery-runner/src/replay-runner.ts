import { HASH_PATTERN, hashCanonical, hashText, isSuccess, type JsonValue } from './scenario-shared.js';

export type { JsonPrimitive, JsonValue } from './scenario-shared.js';

export type ProtectedDeliveryAttempt = Readonly<{
  statusCode: number;
  deliveryConfirmed: boolean;
  responseBodyHash: `0x${string}`;
  /**
   * A signature the provider itself produced over responseBodyHash, if it signs its responses
   * (see provider-signature.ts). Absent for providers that don't -- verification is opt-in,
   * driven by whether the caller configured an expected signer address.
   */
  providerSignature?: `0x${string}`;
}>;

export interface ProtectedDeliveryClient {
  execute(
    input: Readonly<{
      method: 'GET' | 'POST';
      route: string;
      requestBody?: JsonValue;
      paymentReceipt: string;
      idempotencyKey: string;
      signal?: AbortSignal;
    }>,
  ): Promise<ProtectedDeliveryAttempt>;
}

export type ReplayScenario = Readonly<{
  scenarioId: string;
  targetServiceId: string;
  targetVersionHash: `0x${string}`;
  policyHash: `0x${string}`;
  method: 'GET' | 'POST';
  route: string;
  requestBody?: JsonValue;
  paymentReceipt: string;
  paymentProofHash: `0x${string}`;
  acceptedReplayRejectionStatuses?: readonly number[];
}>;

export type ReplayFailureCode =
  | 'INITIAL_PROTECTED_DELIVERY_FAILED'
  | 'PAYMENT_PROOF_REPLAY_ACCEPTED'
  | 'REPLAY_PROBE_INCONCLUSIVE'
  | 'INVALID_CREDENTIAL_ACCEPTED'
  | 'INVALID_CREDENTIAL_PROBE_INCONCLUSIVE'
  | 'PROVIDER_SIGNATURE_INVALID';

export type ReplayEvidence = Readonly<{
  scenarioId: string;
  targetServiceId: string;
  targetVersionHash: `0x${string}`;
  policyHash: `0x${string}`;
  paymentProofHash: `0x${string}`;
  presentedReceiptHash: `0x${string}`;
  result: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
  failureCode?: ReplayFailureCode;
  attempts: readonly Readonly<{
    phase: 'INITIAL' | 'REPLAY';
    requestHash: `0x${string}`;
    responseHash?: `0x${string}`;
    statusCode?: number;
    deliveryConfirmed?: boolean;
    providerSignature?: `0x${string}`;
  }>[];
}>;

const DEFAULT_REPLAY_REJECTION_STATUSES = Object.freeze([401, 402, 409]);

export class ProtectedDeliveryReplayRunner {
  readonly #client: ProtectedDeliveryClient;

  constructor(client: ProtectedDeliveryClient) {
    this.#client = client;
  }

  async run(scenario: ReplayScenario, signal?: AbortSignal): Promise<ReplayEvidence> {
    validateScenario(scenario);
    const initialKey = `${scenario.scenarioId}:initial`;
    const replayKey = `${scenario.scenarioId}:replay`;
    const attempts: ReplayEvidence['attempts'][number][] = [];

    const initial = await this.#attempt(scenario, initialKey, 'INITIAL', signal);
    attempts.push(initial.evidence);
    if (!initial.response) {
      return evidence(scenario, 'INCONCLUSIVE', 'INITIAL_PROTECTED_DELIVERY_FAILED', attempts);
    }
    if (!isSuccess(initial.response.statusCode) || !initial.response.deliveryConfirmed) {
      return evidence(scenario, 'FAIL', 'INITIAL_PROTECTED_DELIVERY_FAILED', attempts);
    }

    const replay = await this.#attempt(scenario, replayKey, 'REPLAY', signal);
    attempts.push(replay.evidence);
    if (!replay.response) {
      return evidence(scenario, 'INCONCLUSIVE', 'REPLAY_PROBE_INCONCLUSIVE', attempts);
    }
    if (isSuccess(replay.response.statusCode)) {
      return evidence(scenario, 'FAIL', 'PAYMENT_PROOF_REPLAY_ACCEPTED', attempts);
    }

    const acceptedStatuses = new Set(scenario.acceptedReplayRejectionStatuses ?? DEFAULT_REPLAY_REJECTION_STATUSES);
    if (!acceptedStatuses.has(replay.response.statusCode)) {
      return evidence(scenario, 'INCONCLUSIVE', 'REPLAY_PROBE_INCONCLUSIVE', attempts);
    }
    return evidence(scenario, 'PASS', undefined, attempts);
  }

  async #attempt(
    scenario: ReplayScenario,
    idempotencyKey: string,
    phase: 'INITIAL' | 'REPLAY',
    signal?: AbortSignal,
  ): Promise<
    Readonly<{
      response?: ProtectedDeliveryAttempt;
      evidence: ReplayEvidence['attempts'][number];
    }>
  > {
    const requestHash = hashCanonical({
      method: scenario.method,
      route: scenario.route,
      requestBody: scenario.requestBody ?? null,
      idempotencyKey,
    });
    try {
      const response = await this.#client.execute({
        method: scenario.method,
        route: scenario.route,
        ...(scenario.requestBody === undefined ? {} : { requestBody: scenario.requestBody }),
        paymentReceipt: scenario.paymentReceipt,
        idempotencyKey,
        ...(signal ? { signal } : {}),
      });
      validateAttempt(response);
      return {
        response,
        evidence: {
          phase,
          requestHash,
          responseHash: response.responseBodyHash,
          statusCode: response.statusCode,
          deliveryConfirmed: response.deliveryConfirmed,
          ...(response.providerSignature ? { providerSignature: response.providerSignature } : {}),
        },
      };
    } catch {
      return { evidence: { phase, requestHash } };
    }
  }
}

function evidence(
  scenario: ReplayScenario,
  result: ReplayEvidence['result'],
  failureCode: ReplayFailureCode | undefined,
  attempts: ReplayEvidence['attempts'],
): ReplayEvidence {
  return {
    scenarioId: scenario.scenarioId,
    targetServiceId: scenario.targetServiceId,
    targetVersionHash: scenario.targetVersionHash,
    policyHash: scenario.policyHash,
    paymentProofHash: scenario.paymentProofHash,
    presentedReceiptHash: hashText(scenario.paymentReceipt),
    result,
    ...(failureCode ? { failureCode } : {}),
    attempts,
  };
}

function validateScenario(scenario: ReplayScenario): void {
  if (!scenario.scenarioId || !scenario.targetServiceId) throw new Error('Replay scenario identity is required');
  const routeBase = 'https://protected-target.invalid';
  const parsedRoute = new URL(scenario.route, routeBase);
  if (
    !scenario.route.startsWith('/') ||
    parsedRoute.origin !== routeBase ||
    parsedRoute.hash ||
    /\\|%5c/i.test(scenario.route)
  ) {
    throw new Error('Replay route must be an origin-relative path');
  }
  if (!scenario.paymentReceipt) throw new Error('Payment receipt is required');
  for (const [field, value] of [
    ['targetVersionHash', scenario.targetVersionHash],
    ['policyHash', scenario.policyHash],
    ['paymentProofHash', scenario.paymentProofHash],
  ] as const) {
    if (!HASH_PATTERN.test(value)) throw new Error(`${field} must be a 32-byte hash`);
  }
  const statuses = scenario.acceptedReplayRejectionStatuses ?? DEFAULT_REPLAY_REJECTION_STATUSES;
  if (statuses.length === 0 || statuses.some((status) => !Number.isInteger(status) || status < 400 || status > 499)) {
    throw new Error('Replay rejection statuses must be non-empty HTTP 4xx values');
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
