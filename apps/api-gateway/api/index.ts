import type { IncomingMessage, ServerResponse } from 'node:http';

import { buildApp, type BuiltApp } from '../src/server.js';

/**
 * Cached across warm invocations of the same Vercel function instance -- rebuilding this on every
 * request would open a fresh PostgreSQL connection pool (and re-verify schema readiness) per
 * request, which exhausts Postgres's connection limit under any real traffic. A cold start still
 * pays the cost once; every warm request after that reuses the same pool and Fastify instance.
 */
let cachedApp: Promise<BuiltApp> | null = null;

async function getApp(): Promise<BuiltApp> {
  if (!cachedApp) {
    cachedApp = buildApp().then(async (built) => {
      await built.app.ready();
      return built;
    });
  }
  return cachedApp;
}

/**
 * Fastify's own createApp() (src/app.ts) already owns routing, CORS, and error handling --
 * app.listen() is the only thing this can't do on Vercel, since Vercel owns the request/response
 * lifecycle itself. Fastify always creates a real node:http Server internally even without
 * listen(); handing Vercel's (req, res) pair to that server via a synthetic 'request' event runs
 * the exact same routing/plugin pipeline a real inbound connection would.
 */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { app } = await getApp();
  app.server.emit('request', req, res);
}
