import type { IncomingMessage, ServerResponse } from 'node:http';

import { buildDemoTargetApp, type BuiltDemoTarget } from '../src/build-app.js';

/**
 * Cached across warm invocations of the same function instance: building the app also creates the
 * RPC clients and parses the runtime config, which there is no reason to repeat per request.
 */
let cachedApp: Promise<BuiltDemoTarget> | null = null;

async function getApp(): Promise<BuiltDemoTarget> {
  if (!cachedApp) {
    cachedApp = (async () => {
      const built = buildDemoTargetApp();
      await built.app.ready();
      return built;
    })().catch((error: unknown) => {
      // Never let one bad cold start pin the same error on every later request.
      cachedApp = null;
      throw error;
    });
  }
  return cachedApp;
}

/**
 * Fastify owns routing and the x402 challenge/settlement logic; listen() is the only thing it
 * cannot do here, since the platform owns the request/response lifecycle. Fastify still creates a
 * real node:http server internally, so emitting a synthetic 'request' runs the identical pipeline.
 */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { app } = await getApp();
  app.server.emit('request', req, res);
}
