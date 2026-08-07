import { isIP } from 'node:net';

import { isForbiddenHost } from './mandate.js';

/**
 * `isForbiddenHost` in mandate.ts only ever sees the literal hostname string at mandate-creation
 * time. That cannot catch DNS rebinding (a hostname that resolves to a public IP when the mandate
 * is built, then to a private IP by the time the request actually fires) or a redirect chain that
 * hops from an allowed host into a forbidden one. This wraps `fetch` to close both gaps at the
 * moment the network call actually happens, which is the only point either attack is visible.
 */
export class EgressForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EgressForbiddenError';
  }
}

export type EgressSafeFetchOptions = Readonly<{
  maxRedirects?: number;
  resolveHost?: (hostname: string) => Promise<readonly string[]>;
}>;

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export function createEgressSafeFetch(
  baseFetch: typeof fetch = fetch,
  options: EgressSafeFetchOptions = {},
): typeof fetch {
  const maxRedirects = options.maxRedirects ?? 5;
  const resolveHost = options.resolveHost ?? defaultResolveHost;

  return (async (input: FetchInput, init?: FetchInit) => {
    let url = toUrl(input);
    let currentInit = init;

    for (let hop = 0; hop <= maxRedirects; hop++) {
      await assertHostAllowed(url.hostname, resolveHost);
      const response = await baseFetch(url, { ...currentInit, redirect: 'manual' });
      if (!REDIRECT_STATUSES.has(response.status)) return response;

      const location = response.headers.get('location');
      if (!location) return response;
      const nextUrl = new URL(location, url);
      if (nextUrl.origin !== url.origin) {
        // Anything the caller put in headers (payment receipts, idempotency keys, auth tokens)
        // was meant for the origin they asked for, not for wherever a 3xx from that origin points
        // next -- a compromised or malicious target could otherwise redirect to a host it controls
        // and simply read those secrets back out of the replayed request.
        currentInit = stripCrossOriginHeaders(currentInit);
      }
      url = nextUrl;
      currentInit = downgradeForRedirect(response.status, currentInit);
    }
    throw new EgressForbiddenError(`Refused to follow more than ${maxRedirects} redirects`);
  }) as typeof fetch;
}

async function assertHostAllowed(
  hostname: string,
  resolveHost: (hostname: string) => Promise<readonly string[]>,
): Promise<void> {
  if (isForbiddenHost(hostname)) {
    throw new EgressForbiddenError(`Host is forbidden: ${hostname}`);
  }
  const addresses = isIP(hostname) ? [hostname] : await resolveHost(hostname);
  for (const address of addresses) {
    if (isForbiddenHost(address)) {
      throw new EgressForbiddenError(`Host ${hostname} resolves to a forbidden address: ${address}`);
    }
  }
}

async function defaultResolveHost(hostname: string): Promise<readonly string[]> {
  const { lookup } = await import('node:dns/promises');
  const results = await lookup(hostname, { all: true, verbatim: true });
  if (results.length === 0) throw new EgressForbiddenError(`DNS resolution returned no addresses for ${hostname}`);
  return results.map((result) => result.address);
}

// Content negotiation headers are safe to keep pointed at a new origin; everything else the
// caller supplied (auth tokens, payment receipts, idempotency keys, cookies) is not.
const CROSS_ORIGIN_SAFE_HEADERS = new Set(['accept', 'content-type']);

function stripCrossOriginHeaders(init: FetchInit): FetchInit {
  if (!init?.headers) return init;
  const filtered = new Headers();
  for (const [name, value] of new Headers(init.headers)) {
    if (CROSS_ORIGIN_SAFE_HEADERS.has(name.toLowerCase())) filtered.set(name, value);
  }
  return { ...init, headers: filtered };
}

function toUrl(input: FetchInput): URL {
  if (input instanceof URL) return new URL(input);
  if (typeof input === 'string') return new URL(input);
  return new URL(input.url);
}

// A 303 (and, per widely-followed browser/fetch convention, a 301/302 on a non-GET/HEAD request)
// converts the retry into a bodyless GET. A 307/308 must preserve the original method and body.
function downgradeForRedirect(status: number, init: FetchInit): FetchInit {
  const method = (init?.method ?? 'GET').toUpperCase();
  const mustPreserve = status === 307 || status === 308;
  if (mustPreserve || method === 'GET' || method === 'HEAD') return init;
  const { body: _body, ...rest } = init ?? {};
  return { ...rest, method: 'GET' };
}
