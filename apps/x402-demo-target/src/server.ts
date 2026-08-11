import { buildDemoTargetApp } from './build-app.js';

async function start(): Promise<void> {
  const { app, config } = buildDemoTargetApp(process.env);

  await app.listen({ host: config.host, port: config.port });
  process.stdout.write(`x402 demo target (${config.mode}) listening on ${config.host}:${config.port}\n`);

  let shuttingDown = false;
  async function shutdown(signal: NodeJS.Signals): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`Received ${signal}; stopping x402 demo target\n`);
    await app.close();
  }

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

await start();
