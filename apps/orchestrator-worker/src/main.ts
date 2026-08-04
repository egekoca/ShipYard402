import {
  PostgresAttestationStore,
  PostgresEvidencePackStore,
  PostgresOrchestratorJobQueue,
  PostgresQuoteRepository,
  PostgresRunRepository,
  assertShipyardSchemaReady,
  createShipyardPool,
} from '@shipyard402/persistence-postgres';
import { JsonRpcProvider, Wallet } from 'ethers';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import OpenAI from 'openai';
import { OpenAiRiskClassifier } from '@shipyard402/risk-classifier';

import { EthersNativePaymentSender, EthersRegistryAttestor, EthersToolReceiptSigner } from './ethers-adapters.js';
import { createFetchPurchaseClient } from './fetch-purchase-client.js';
import { createFetchProtectedDeliveryClient } from './protected-delivery-fetch-client.js';
import { parseOrchestratorWorkerRuntimeConfig } from './runtime-config.js';
import { OrchestratorJobHandler, processNextOrchestratorJob } from './worker.js';

async function start(): Promise<void> {
  const config = parseOrchestratorWorkerRuntimeConfig(process.env);
  const pool = createShipyardPool({ connectionString: config.database.connectionString, useTls: config.database.useTls });

  try {
    await pool.query('SELECT 1');
    await assertShipyardSchemaReady(pool);

    const provider = new JsonRpcProvider(config.rpcUrl, config.chainId, { staticNetwork: true });
    const network = await provider.getNetwork();
    if (network.chainId !== BigInt(config.chainId)) throw new Error(`RPC chain mismatch: ${network.chainId}`);

    const signerWallet = new Wallet(config.signerPrivateKey, provider);
    const toolReceiptSignerWallet = new Wallet(config.toolReceiptSignerPrivateKey, provider);
    const registryAbi = JSON.parse(await readFile(
      resolve('contracts/out-solc/src_ShipyardRunRegistry_sol_ShipyardRunRegistry.abi'),
      'utf8',
    ));

    const handler = new OrchestratorJobHandler({
      runRepository: new PostgresRunRepository(pool),
      quoteRepository: new PostgresQuoteRepository(pool),
      riskClassifier: new OpenAiRiskClassifier({
        apiKey: config.openAi.apiKey,
        model: config.openAi.model,
        client: new OpenAI({ apiKey: config.openAi.apiKey }),
      }),
      mandatoryScenarios: config.mandatoryScenarios,
      shipyardAgentId: config.shipyardAgentId,
      demoTarget: { ...config.demoTarget, chainId: config.chainId },
      deliveryClient: createFetchProtectedDeliveryClient(config.demoTarget.baseUrl),
      paymentSender: new EthersNativePaymentSender(signerWallet, provider, BigInt(config.maximumProcurementSpendAtomic)),
      purchaseClient: createFetchPurchaseClient(config.demoTarget.baseUrl),
      toolReceiptSigner: new EthersToolReceiptSigner(toolReceiptSignerWallet),
      evidencePackStore: new PostgresEvidencePackStore(pool),
      evidencePublicBaseUrl: config.evidencePublicBaseUrl,
      attestor: new EthersRegistryAttestor(signerWallet, config.registryAddress, config.chainId, registryAbi),
      attestationStore: new PostgresAttestationStore(pool),
    });
    const queue = new PostgresOrchestratorJobQueue(pool);
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());
    process.once('SIGTERM', () => controller.abort());
    process.stdout.write(JSON.stringify({ event: 'orchestrator_worker_ready', workerId: config.workerId }) + '\n');

    while (!controller.signal.aborted) {
      const processed = await processNextOrchestratorJob(queue, handler, {
        workerId: config.workerId,
        leaseDurationSeconds: config.leaseDurationSeconds,
      });
      if (!processed) await abortableDelay(config.pollIntervalMilliseconds, controller.signal);
    }
  } finally {
    await pool.end();
  }
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolvePromise) => {
    const timeout = setTimeout(done, milliseconds);
    signal.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timeout);
      signal.removeEventListener('abort', done);
      resolvePromise();
    }
  });
}

await start().catch((error) => {
  process.stderr.write(JSON.stringify({ event: 'orchestrator_worker_stopped', code: 'SAFE_RUNTIME_FAILURE', message: String(error) }) + '\n');
  process.exitCode = 1;
});
