import type { IncomingMessage, ServerResponse } from 'node:http';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const buildApp = vi.fn();

vi.mock('../src/server.js', () => ({ buildApp: (...args: unknown[]) => buildApp(...args) }));

describe('Vercel handler cached app promise', () => {
  beforeEach(() => {
    vi.resetModules();
    buildApp.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retries buildApp on the next request after a transient failure instead of replaying the same rejection forever', async () => {
    const readyApp = { ready: vi.fn(async () => {}), server: { emit: vi.fn() } };
    buildApp
      .mockRejectedValueOnce(new Error('PostgreSQL readiness check failed'))
      .mockResolvedValueOnce({ app: readyApp, pool: {}, config: {} });

    const { default: handler } = await import('./index.js');
    const req = {} as IncomingMessage;
    const res = {} as ServerResponse;

    await expect(handler(req, res)).rejects.toThrow('PostgreSQL readiness check failed');
    await expect(handler(req, res)).resolves.toBeUndefined();

    expect(buildApp).toHaveBeenCalledTimes(2);
    expect(readyApp.server.emit).toHaveBeenCalledWith('request', req, res);
  });

  it('reuses the same built app across requests once it succeeds (no rebuild per request)', async () => {
    const readyApp = { ready: vi.fn(async () => {}), server: { emit: vi.fn() } };
    buildApp.mockResolvedValueOnce({ app: readyApp, pool: {}, config: {} });

    const { default: handler } = await import('./index.js');
    const req = {} as IncomingMessage;
    const res = {} as ServerResponse;

    await handler(req, res);
    await handler(req, res);

    expect(buildApp).toHaveBeenCalledTimes(1);
  });
});
