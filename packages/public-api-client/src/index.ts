export type RunStatus =
  | 'DRAFT'
  | 'QUOTED'
  | 'PAYMENT_REQUIRED'
  | 'FUNDED'
  | 'ANALYZING'
  | 'PLAN_COMPILED'
  | 'PROCURING'
  | 'EXECUTING'
  | 'REPLANNING'
  | 'EVIDENCE_BUILDING'
  | 'ATTESTING'
  | 'DELIVERED_PASS'
  | 'DELIVERED_CONDITIONAL'
  | 'DELIVERED_FAIL'
  | 'DELIVERED_INCONCLUSIVE'
  | 'CANCELLED'
  | 'EXPIRED';

export type RunResult = 'PASS' | 'CONDITIONAL' | 'FAIL' | 'INCONCLUSIVE';

/** One row of a customer's own run history -- enough to render a clickable list, not the full
 * detail GET /v1/runs/:runId returns. */
export type RunSummaryResponse = Readonly<{
  id: string;
  status: RunStatus;
  result?: RunResult;
  targetServiceId: string;
  createdAt: string;
  updatedAt: string;
}>;

export type QuoteRequest = Readonly<{
  organizationId: string;
  requesterAddress: `0x${string}`;
  targetAgentId: string;
  targetServiceId: string;
  targetVersionHash: `0x${string}`;
  previousVersionHash?: `0x${string}`;
  policyHash: `0x${string}`;
  x402Endpoint: string;
  openApiUrl: string;
  maximumCustomerBudgetAtomic: string;
}>;

export type QuoteResponse = Readonly<{
  id: string;
  pricingStatus: 'HYPOTHESIS';
  totalAtomicAmount: string;
  refundableToolBudgetAtomic: string;
  createdAt: string;
  expiresAt: string;
  quoteCommitment: `0x${string}`;
  capabilitySnapshot: Readonly<{
    chainId: number;
    tokenAddress: `0x${string}`;
    tokenSymbol: string;
    tokenDecimals: number;
    receivingAddress: `0x${string}`;
    mode: 'ERC20_DIRECT';
  }>;
  lineItems: Readonly<Record<string, string>>;
  nextAction: string;
  warning: string;
}>;

export type RunResponse = Readonly<{
  run: Readonly<{
    id: string;
    status: RunStatus;
    revision: number;
    createdAt: string;
    updatedAt: string;
  }>;
  payment: Readonly<{
    status: string;
    mode: 'ERC20_DIRECT';
    nextAction: string;
    orderId?: string;
    expiresAt?: string;
    /** The customer's actual on-chain funding transaction, once verified -- for an explorer link. */
    transactionHash?: `0x${string}`;
    chainId?: number;
    paymentRequired?: Readonly<{
      x402Version: number;
      resource: Readonly<{ url: string; description?: string; mimeType?: string }>;
      accepts: readonly Readonly<{
        scheme: string;
        network: string;
        amount: string;
        asset: string;
        payTo: string;
        maxTimeoutSeconds: number;
        extra?: Readonly<Record<string, unknown>>;
      }>[];
      extensions?: Readonly<Record<string, unknown>>;
    }>;
  }>;
}>;

export type ToolReceipt = Readonly<{
  receiptVersion: '1.0';
  runId: string;
  toolAgentId: string;
  targetAgentId: string;
  targetVersionHash: `0x${string}`;
  policyHash: `0x${string}`;
  scenarioId: string;
  requestHash: `0x${string}`;
  responseHash: `0x${string}`;
  paymentProofHash: `0x${string}`;
  chainTransactionHash: `0x${string}`;
  chainId: number;
  startedAt: number;
  completedAt: number;
  result: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
  failureCode: string;
  toolVersion: string;
  signatureScheme: 'EIP712';
  signature: `0x${string}`;
}>;

/** The AI's raw, pre-compilation proposal -- advisory only, never the authority for what ran. */
export type AiRiskProposal = Readonly<{
  riskLevel: string;
  proposedScenarios: readonly string[];
  proposedToolBudgetAtomic: string;
  rationale: string;
}>;

/** One tool-agent-to-target-agent exchange per scenario probe, already-hashed (no raw bodies). */
export type ScenarioTrace = Readonly<{
  scenarioId: string;
  attempts: readonly Readonly<{
    phase: 'INITIAL' | 'REPLAY';
    requestHash: `0x${string}`;
    responseHash?: `0x${string}`;
    statusCode?: number;
    deliveryConfirmed?: boolean;
  }>[];
}>;

export type EvidencePublicManifest = Readonly<{
  runId: string;
  targetServiceId: string;
  targetVersionHash: `0x${string}`;
  policyHash: `0x${string}`;
  riskLevel: string;
  rationale: string;
  toolBudgetAtomic: string;
  /** Absent when the run was resumed from a checkpoint written before this field existed. */
  aiProposal?: AiRiskProposal;
  scenarios: readonly string[];
  scenarioTraces: readonly ScenarioTrace[];
  result: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
  toolReceipts: readonly ToolReceipt[];
}>;

export type EvidenceResponse = Readonly<{
  runId: string;
  evidenceRoot: `0x${string}`;
  toolReceiptRoot: `0x${string}`;
  uri: string;
  contentHash: `0x${string}`;
  publicManifest: EvidencePublicManifest;
  builtAt: string;
}>;

/**
 * The compiled test plan, available as soon as the orchestrator reaches PLAN_COMPILED -- well
 * before the full evidence pack exists. Same shape as EvidencePublicManifest's plan fields, just
 * available earlier.
 */
export type PlanResponse = Readonly<{
  runId: string;
  riskLevel: string;
  scenarios: readonly string[];
  toolBudgetAtomic: string;
  rationale: string;
  aiProposal?: AiRiskProposal;
}>;

/**
 * Real historical timing, not a guessed SLA -- medians computed from how long recent completed
 * runs actually spent on each pipeline step. A bucket is absent until enough completed runs exist
 * to compute it.
 */
export type StepDurationStatsResponse = Readonly<{
  sampleSize: number;
  medianMillisecondsByStep: Readonly<
    Partial<Record<'payment' | 'plan' | 'procurement' | 'evidence' | 'attestation', number>>
  >;
}>;

export type AttestationResponse = Readonly<{
  runId: string;
  registryAddress: `0x${string}`;
  chainId: number;
  transactionHash: `0x${string}`;
  attestor: `0x${string}`;
  expiresAt: string;
  submittedAt: string;
}>;

export class ShipyardApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ShipyardApiError';
    this.status = status;
    this.code = code;
  }
}

export class ShipyardApiClient {
  readonly #baseUrl: URL;
  readonly #fetch: typeof fetch;

  constructor(baseUrl: string, fetchImplementation: typeof fetch = fetch.bind(globalThis)) {
    this.#baseUrl = normalizeBaseUrl(baseUrl);
    this.#fetch = fetchImplementation;
  }

  async createQuote(input: QuoteRequest, signal?: AbortSignal): Promise<QuoteResponse> {
    return this.#request<QuoteResponse>('/v1/quotes', {
      method: 'POST',
      body: JSON.stringify(input),
      ...(signal === undefined ? {} : { signal }),
    });
  }

  async createRun(quoteId: string, idempotencyKey: string, signal?: AbortSignal): Promise<RunResponse> {
    return this.#request<RunResponse>('/v1/runs', {
      method: 'POST',
      body: JSON.stringify({ quoteId, idempotencyKey }),
      ...(signal === undefined ? {} : { signal }),
    });
  }

  async requestPaymentChallenge(runId: string, signal?: AbortSignal): Promise<RunResponse> {
    return this.#request<RunResponse>(`/v1/runs/${encodeURIComponent(runId)}/payment-challenge`, {
      method: 'POST',
      ...(signal === undefined ? {} : { signal }),
    }, new Set([402]));
  }

  async getRun(runId: string, signal?: AbortSignal): Promise<RunResponse> {
    return this.#request<RunResponse>(`/v1/runs/${encodeURIComponent(runId)}`, {
      method: 'GET',
      ...(signal === undefined ? {} : { signal }),
    });
  }

  async listRuns(requesterAddress: `0x${string}`, signal?: AbortSignal): Promise<readonly RunSummaryResponse[]> {
    const result = await this.#request<{ runs: readonly RunSummaryResponse[] }>(
      `/v1/runs?requester=${encodeURIComponent(requesterAddress)}`,
      { method: 'GET', ...(signal === undefined ? {} : { signal }) },
    );
    return result.runs;
  }

  async getPlan(runId: string, signal?: AbortSignal): Promise<PlanResponse | null> {
    return this.#getOrNull<PlanResponse>(`/v1/runs/${encodeURIComponent(runId)}/plan`, signal);
  }

  async getStepDurationStats(signal?: AbortSignal): Promise<StepDurationStatsResponse> {
    return this.#request<StepDurationStatsResponse>('/v1/stats/step-durations', {
      method: 'GET',
      ...(signal === undefined ? {} : { signal }),
    });
  }

  async getEvidence(runId: string, signal?: AbortSignal): Promise<EvidenceResponse | null> {
    return this.#getOrNull<EvidenceResponse>(`/v1/runs/${encodeURIComponent(runId)}/evidence`, signal);
  }

  async getAttestation(runId: string, signal?: AbortSignal): Promise<AttestationResponse | null> {
    return this.#getOrNull<AttestationResponse>(`/v1/runs/${encodeURIComponent(runId)}/attestation`, signal);
  }

  async #getOrNull<T>(path: string, signal?: AbortSignal): Promise<T | null> {
    try {
      return await this.#request<T>(path, {
        method: 'GET',
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (error instanceof ShipyardApiError && error.status === 404) return null;
      throw error;
    }
  }

  async getHealth(signal?: AbortSignal): Promise<Readonly<Record<string, unknown>>> {
    return this.#request('/health', {
      method: 'GET',
      ...(signal === undefined ? {} : { signal }),
    });
  }

  async #request<T>(path: string, init: RequestInit, acceptedErrorStatuses = new Set<number>()): Promise<T> {
    const response = await this.#fetch(new URL(path, this.#baseUrl), {
      ...init,
      headers: {
        accept: 'application/json',
        // A JSON content-type on a bodyless request (e.g. requestPaymentChallenge, a pure POST
        // action) makes Fastify reject it as FST_ERR_CTP_EMPTY_JSON_BODY -- only claim JSON when
        // there is actually a body to back the claim.
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...init.headers,
      },
    });
    const payload: unknown = await response.json().catch(() => ({}));
    if (!response.ok && !acceptedErrorStatuses.has(response.status)) {
      const error = payload as { code?: unknown; message?: unknown };
      const code = typeof error.code === 'string' ? error.code : 'SHIPYARD_API_ERROR';
      const message = typeof error.message === 'string' ? error.message : `Shipyard API returned HTTP ${response.status}`;
      throw new ShipyardApiError(response.status, code, message);
    }
    return payload as T;
  }
}

function normalizeBaseUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' && !isLocalDevelopmentUrl(url)) {
    throw new Error('Shipyard API requires HTTPS outside local development');
  }
  url.pathname = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  return url;
}

function isLocalDevelopmentUrl(url: URL): boolean {
  return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
}
