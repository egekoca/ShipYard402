import { x402Client, x402HTTPClient } from '@x402/core/client';
import type { Network, PaymentRequirements } from '@x402/core/types';
import { toClientEvmSigner } from '@x402/evm';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { createPublicClient, defineChain, http, keccak256, toBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { BNB_MAINNET_CHAIN_ID, BNB_MAINNET_NETWORK } from './constants.js';
import type { BnbPaidRequestPort, BnbPaymentQuote } from './ports.js';
import {
  selectPayableRequirement,
  X402RequirementNotPayableError,
  type X402PaymentPolicy,
} from './requirement-policy.js';

/**
 * Talks to a real x402 target over the official `@x402/core` + `@x402/evm` client.
 *
 * What the target charges, in which asset, to whom, and by which transfer method are all read from
 * its own 402 response. `policy` is the only thing fixed in advance, and it only ever narrows:
 * which chain, which assets we hold, how much we will spend, and optionally a pinned recipient.
 */
export function createOfficialBnbX402PaidRequestPort(
  input: Readonly<{
    rpcUrl: string;
    payerPrivateKey: `0x${string}`;
    endpoint: string;
    policy: X402PaymentPolicy;
    fetchImplementation?: typeof fetch;
  }>,
): BnbPaidRequestPort {
  const endpoint = assertPayableEndpoint(input.endpoint);
  const account = privateKeyToAccount(input.payerPrivateKey);
  const chain = bnbChain(input.rpcUrl);
  const publicClient = createPublicClient({ chain, transport: http(input.rpcUrl) });
  const signer = toClientEvmSigner(account, publicClient);
  const fetchImplementation = input.fetchImplementation ?? fetch;

  /**
   * A fresh client per call, pinned to one requirement. The x402 client picks what to pay from a
   * registered policy, so pinning is how the entry our own policy chose -- and only that entry --
   * becomes the one that gets signed, even if the target offered several.
   */
  function clientFor(pinned?: PaymentRequirements): x402Client {
    const client = new x402Client().register(
      BNB_MAINNET_NETWORK as Network,
      new ExactEvmScheme(signer, { rpcUrl: input.rpcUrl }),
    );
    if (pinned) {
      client.registerPolicy((_version, requirements) =>
        requirements.filter((requirement) => sameRequirement(requirement, pinned)),
      );
    }
    return client;
  }

  async function readPaymentRequired(signal?: AbortSignal): Promise<{
    paymentRequired: ReturnType<x402HTTPClient['getPaymentRequiredResponse']>;
  }> {
    const response = await fetchImplementation(endpoint, signal ? { method: 'GET', signal } : { method: 'GET' });
    if (response.status !== 402) throw new Error(`Expected an x402 challenge, received HTTP ${response.status}`);
    const body = await readResponseBody(response.clone());
    const httpClient = new x402HTTPClient(clientFor());
    const paymentRequired = httpClient.getPaymentRequiredResponse(
      (name) => response.headers.get(name),
      isRecord(body) ? (body as never) : undefined,
    );
    if (paymentRequired.x402Version !== 2) throw new Error('x402 target did not return a v2 challenge');
    return { paymentRequired };
  }

  return {
    async quote(signal) {
      const { paymentRequired } = await readPaymentRequired(signal);
      const accepts = (paymentRequired.accepts ?? []) as readonly PaymentRequirements[];
      const selection = selectPayableRequirement(accepts, input.policy);
      if (!selection.payable) {
        // Typed, with the codes attached: "we do not hold that asset" and "the price is above our
        // ceiling" need completely different operator responses, and the caller classifies on them.
        throw new X402RequirementNotPayableError(endpoint, selection.rejected);
      }
      return {
        amountAtomic: selection.payable.amountAtomic,
        asset: selection.payable.asset,
        payTo: selection.payable.payTo,
        transferMethod: selection.payable.transferMethod,
        requirement: selection.payable.requirement,
        paymentRequired,
      };
    },

    async authorize(quote: BnbPaymentQuote, signal) {
      throwIfAborted(signal);
      const client = clientFor(quote.requirement);
      const httpClient = new x402HTTPClient(client);
      const payload = await client.createPaymentPayload(quote.paymentRequired as never);
      const headers = httpClient.encodePaymentSignatureHeader(payload);
      const paymentReceipt = headers['PAYMENT-SIGNATURE'] ?? headers['payment-signature'];
      if (!paymentReceipt) throw new Error('x402 client did not produce a PAYMENT-SIGNATURE header');
      return {
        paymentReceipt,
        paymentProofHash: keccak256(toBytes(paymentReceipt)),
        amountAtomic: quote.amountAtomic,
      };
    },
  };
}

/** Two challenge entries are the same offer when every economically meaningful field matches. */
export function sameRequirement(left: PaymentRequirements, right: PaymentRequirements): boolean {
  const amount = (requirement: PaymentRequirements): string | undefined =>
    'amount' in requirement && typeof requirement.amount === 'string'
      ? requirement.amount
      : 'maxAmountRequired' in requirement && typeof requirement.maxAmountRequired === 'string'
        ? requirement.maxAmountRequired
        : undefined;
  return (
    left.scheme === right.scheme &&
    left.network === right.network &&
    left.asset.toLowerCase() === right.asset.toLowerCase() &&
    left.payTo.toLowerCase() === right.payTo.toLowerCase() &&
    amount(left) === amount(right) &&
    readResource(left) === readResource(right)
  );
}

/** `resource` exists on the v1 shape of the requirements union; absent is a valid answer, not an error. */
function readResource(requirement: PaymentRequirements): string | undefined {
  const record = requirement as unknown as Record<string, unknown>;
  return typeof record['resource'] === 'string' ? record['resource'] : undefined;
}

function assertPayableEndpoint(value: string): string {
  const url = new URL(value);
  const isLoopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    throw new Error('x402 endpoint must use HTTPS, except for loopback development');
  }
  if (url.username || url.password || url.hash) {
    throw new Error('x402 endpoint cannot contain credentials or a fragment');
  }
  return url.toString();
}

function bnbChain(rpcUrl: string) {
  return defineChain({
    id: BNB_MAINNET_CHAIN_ID,
    name: 'BNB Smart Chain',
    nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    blockExplorers: { default: { name: 'BscScan', url: 'https://bscscan.com' } },
  });
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error('Operation aborted');
}
