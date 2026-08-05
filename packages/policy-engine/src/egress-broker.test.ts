import { describe, expect, it, vi } from 'vitest';

import { createEgressSafeFetch, EgressForbiddenError } from './egress-broker.js';

function fakeResolver(map: Record<string, readonly string[]>): (hostname: string) => Promise<readonly string[]> {
  return async (hostname) => {
    const addresses = map[hostname];
    if (!addresses) throw new Error(`unexpected DNS lookup for ${hostname}`);
    return addresses;
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function redirectResponse(location: string, status: number): Response {
  return new Response(null, { status, headers: { location } });
}

describe('createEgressSafeFetch', () => {
  it('refuses a literal forbidden hostname without ever calling the base fetch', async () => {
    const baseFetch = vi.fn();
    const egressFetch = createEgressSafeFetch(baseFetch, { resolveHost: fakeResolver({}) });

    await expect(egressFetch('http://localhost/steal')).rejects.toThrow(EgressForbiddenError);
    expect(baseFetch).not.toHaveBeenCalled();
  });

  it('refuses a hostname that resolves to a private address (DNS rebinding)', async () => {
    const baseFetch = vi.fn();
    const egressFetch = createEgressSafeFetch(baseFetch, {
      resolveHost: fakeResolver({ 'api.example.com': ['10.0.0.5'] }),
    });

    await expect(egressFetch('https://api.example.com/data')).rejects.toThrow(EgressForbiddenError);
    expect(baseFetch).not.toHaveBeenCalled();
  });

  it('allows a request whose hostname resolves to a public address', async () => {
    const baseFetch = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    const egressFetch = createEgressSafeFetch(baseFetch, {
      resolveHost: fakeResolver({ 'api.example.com': ['203.0.113.10'] }),
    });

    const response = await egressFetch('https://api.example.com/data');
    expect(response.status).toBe(200);
    expect(baseFetch).toHaveBeenCalledTimes(1);
    expect(baseFetch.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
  });

  it('follows a redirect chain into another allowed host', async () => {
    const baseFetch = vi.fn()
      .mockResolvedValueOnce(redirectResponse('https://b.example.com/next', 302))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const egressFetch = createEgressSafeFetch(baseFetch, {
      resolveHost: fakeResolver({ 'a.example.com': ['203.0.113.10'], 'b.example.com': ['203.0.113.11'] }),
    });

    const response = await egressFetch('https://a.example.com/start');
    expect(response.status).toBe(200);
    expect(baseFetch).toHaveBeenCalledTimes(2);
  });

  it('refuses to follow a redirect into a forbidden host mid-chain', async () => {
    const baseFetch = vi.fn().mockResolvedValueOnce(redirectResponse('http://169.254.169.254/latest/meta-data', 302));
    const egressFetch = createEgressSafeFetch(baseFetch, {
      resolveHost: fakeResolver({ 'a.example.com': ['203.0.113.10'] }),
    });

    await expect(egressFetch('https://a.example.com/start')).rejects.toThrow(EgressForbiddenError);
    expect(baseFetch).toHaveBeenCalledTimes(1);
  });

  it('gives up after too many redirects', async () => {
    const baseFetch = vi.fn().mockImplementation(async () => redirectResponse('https://a.example.com/loop', 302));
    const egressFetch = createEgressSafeFetch(baseFetch, {
      maxRedirects: 2,
      resolveHost: fakeResolver({ 'a.example.com': ['203.0.113.10'] }),
    });

    await expect(egressFetch('https://a.example.com/start')).rejects.toThrow(EgressForbiddenError);
    expect(baseFetch).toHaveBeenCalledTimes(3);
  });

  it('downgrades a POST to a bodyless GET on a 303 redirect', async () => {
    const baseFetch = vi.fn()
      .mockResolvedValueOnce(redirectResponse('https://a.example.com/done', 303))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const egressFetch = createEgressSafeFetch(baseFetch, {
      resolveHost: fakeResolver({ 'a.example.com': ['203.0.113.10'] }),
    });

    await egressFetch('https://a.example.com/start', { method: 'POST', body: 'payload' });
    const secondCallInit = baseFetch.mock.calls[1]?.[1];
    expect(secondCallInit).toMatchObject({ method: 'GET' });
    expect(secondCallInit).not.toHaveProperty('body');
  });

  it('preserves method and body across a 307 redirect', async () => {
    const baseFetch = vi.fn()
      .mockResolvedValueOnce(redirectResponse('https://a.example.com/done', 307))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const egressFetch = createEgressSafeFetch(baseFetch, {
      resolveHost: fakeResolver({ 'a.example.com': ['203.0.113.10'] }),
    });

    await egressFetch('https://a.example.com/start', { method: 'POST', body: 'payload' });
    const secondCallInit = baseFetch.mock.calls[1]?.[1];
    expect(secondCallInit).toMatchObject({ method: 'POST', body: 'payload' });
  });

  it('treats a literal IP target as its own address, skipping DNS resolution', async () => {
    const baseFetch = vi.fn();
    const egressFetch = createEgressSafeFetch(baseFetch, { resolveHost: fakeResolver({}) });

    await expect(egressFetch('http://127.0.0.1/admin')).rejects.toThrow(EgressForbiddenError);
    expect(baseFetch).not.toHaveBeenCalled();
  });
});
