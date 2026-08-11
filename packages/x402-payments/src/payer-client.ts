import {
  chainIdFromNetwork,
  encodePaymentHeader,
  EXACT_SCHEME,
  signExactEvmAuthorization,
  X402_VERSION,
  type ExactEvmRequirements,
  type PaymentHeader,
  type TransferAuthorization,
} from './exact-evm.js';

/**
 * The buyer half of x402 `exact`: negotiate a paid resource's 402 challenge and produce a signed
 * `X-PAYMENT` for it. This is the real protocol flow -- GET the resource, read the server's own
 * advertised requirements, and sign an EIP-3009 authorization for exactly what it asked -- not a
 * bespoke pre-payment. The nonce and validity window are supplied by the caller so the resulting
 * payment is a checkpointable, spend-once artifact (its nonce is consumed on settlement).
 */

export class X402NegotiationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'X402NegotiationError';
    this.code = code;
  }
}

export type AcquirePaymentInput = Readonly<{
  /** The paid resource URL to negotiate against. */
  endpoint: string;
  from: `0x${string}`;
  /** Fresh 32-byte hex; the caller owns it so it can be checkpointed before the payment is used. */
  nonce: `0x${string}`;
  validAfterSec: number;
  validBeforeSec: number;
  /** Signs EIP-712 typed data -- the payer's own wallet. */
  signTypedData: Parameters<typeof signExactEvmAuthorization>[0]['signTypedData'];
  /** Hard ceiling: refuse to sign if the server asks for more than this (atomic units). */
  maxAmountAtomic: string;
  /**
   * The only assets this payer will sign for. The 402 challenge is written by the *target*, which
   * for a marketplace run is a service the customer chose and we do not control -- so `asset`,
   * `payTo` and the EIP-712 domain all arrive attacker-controlled. Without this list the ceiling
   * is the only bound, and an atomic ceiling means nothing across decimals: 1,100,000 atomic is
   * about a dollar of 6-decimal USDC and about 0.011 of an 8-decimal wrapped BTC. Worse, the
   * signed domain's verifyingContract *is* the advertised asset, so an unbounded payer is a blind
   * signer against any contract on the chain sharing the TransferWithAuthorization typehash.
   */
  allowedAssets: readonly `0x${string}`[];
  /** The chain the payer holds funds on; an accepts entry on any other chain is unusable. */
  expectedChainId: number;
  fetchImpl?: typeof fetch;
}>;

export type AcquiredPayment = Readonly<{
  requirements: ExactEvmRequirements;
  paymentHeader: string;
  authorization: TransferAuthorization;
}>;

type RawRequirements = Record<string, unknown>;

/**
 * Performs the 402 negotiation and returns a signed X-PAYMENT. Throws `X402NegotiationError` with a
 * specific code at every point the server's challenge is unusable or over budget -- the caller
 * (procurement) turns those into a denied/failed run rather than silently overpaying or signing a
 * malformed authorization.
 */
export async function acquireExactEvmPayment(input: AcquirePaymentInput): Promise<AcquiredPayment> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const challenge = await fetchImpl(input.endpoint, { method: 'GET' });

  if (challenge.status !== 402) {
    throw new X402NegotiationError(
      'UNEXPECTED_STATUS',
      `Expected a 402 payment challenge, received HTTP ${challenge.status}`,
    );
  }

  let body: unknown;
  try {
    body = await challenge.json();
  } catch {
    throw new X402NegotiationError('MALFORMED_CHALLENGE', 'The 402 challenge body was not valid JSON');
  }

  const accepts = (body as { accepts?: unknown }).accepts;
  if (!Array.isArray(accepts) || accepts.length === 0) {
    throw new X402NegotiationError('NO_ACCEPTS', 'The 402 challenge advertised no payment requirements');
  }

  const requirements = selectExactEvmRequirements(accepts, input.expectedChainId, input.allowedAssets);
  if (!requirements) {
    throw new X402NegotiationError(
      'NO_PAYABLE_REQUIREMENT',
      `No exact-evm requirement on chain ${input.expectedChainId} in an allowed asset in the challenge`,
    );
  }

  if (BigInt(requirements.maxAmountRequired) > BigInt(input.maxAmountAtomic)) {
    throw new X402NegotiationError(
      'AMOUNT_OVER_BUDGET',
      `Server asked ${requirements.maxAmountRequired} atomic, over the ${input.maxAmountAtomic} ceiling`,
    );
  }

  const payload = await signExactEvmAuthorization({
    requirements,
    from: input.from,
    nonce: input.nonce,
    validAfterSec: input.validAfterSec,
    validBeforeSec: input.validBeforeSec,
    signTypedData: input.signTypedData,
  });

  const header: PaymentHeader = {
    x402Version: X402_VERSION,
    scheme: EXACT_SCHEME,
    network: requirements.network,
    payload,
  };

  return { requirements, paymentHeader: encodePaymentHeader(header), authorization: payload.authorization };
}

/**
 * Picks the first `accepts` entry that is exact-evm on the payer's chain. Validating the shape here
 * (rather than trusting the server's JSON) means a malformed or partial requirement is rejected as
 * unpayable instead of producing a signature over garbage.
 */
function selectExactEvmRequirements(
  accepts: unknown[],
  expectedChainId: number,
  allowedAssets: readonly `0x${string}`[],
): ExactEvmRequirements | null {
  const allowed = new Set(allowedAssets.map((asset) => asset.toLowerCase()));
  for (const candidate of accepts) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const raw = candidate as RawRequirements;
    if (raw['scheme'] !== EXACT_SCHEME) continue;
    if (typeof raw['network'] !== 'string' || chainIdFromNetwork(raw['network']) !== expectedChainId) continue;
    const parsed = parseRequirements(raw);
    if (!parsed) continue;
    // Checked after parsing so a malformed entry cannot smuggle a non-string asset past the set.
    if (!allowed.has(parsed.asset.toLowerCase())) continue;
    return parsed;
  }
  return null;
}

function parseRequirements(raw: RawRequirements): ExactEvmRequirements | null {
  const { network, maxAmountRequired, payTo, asset, extra } = raw;
  if (typeof maxAmountRequired !== 'string' || !/^\d+$/.test(maxAmountRequired)) return null;
  if (!isAddressLike(payTo) || !isAddressLike(asset)) return null;
  if (typeof extra !== 'object' || extra === null) return null;
  const { name, version } = extra as RawRequirements;
  if (typeof name !== 'string' || typeof version !== 'string') return null;
  return {
    scheme: EXACT_SCHEME,
    network: network as string,
    maxAmountRequired,
    resource: typeof raw['resource'] === 'string' ? (raw['resource'] as string) : '',
    description: typeof raw['description'] === 'string' ? (raw['description'] as string) : '',
    mimeType: typeof raw['mimeType'] === 'string' ? (raw['mimeType'] as string) : 'application/json',
    payTo: payTo as `0x${string}`,
    asset: asset as `0x${string}`,
    maxTimeoutSeconds: typeof raw['maxTimeoutSeconds'] === 'number' ? (raw['maxTimeoutSeconds'] as number) : 300,
    extra: { name, version },
  };
}

function isAddressLike(value: unknown): value is `0x${string}` {
  return typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value);
}
