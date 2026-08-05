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

export type EvidencePublicManifest = Readonly<{
  runId: string;
  targetServiceId: string;
  targetVersionHash: `0x${string}`;
  policyHash: `0x${string}`;
  riskLevel: string;
  scenarios: readonly string[];
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
      headers: { accept: 'application/json', 'content-type': 'application/json', ...init.headers },
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
