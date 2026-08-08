import {
  PostgresAttestationStore,
  PostgresEvidencePackStore,
  PostgresOrchestratorCheckpointStore,
  PostgresOrchestratorJobQueue,
  PostgresQuoteRepository,
  PostgresRunRepository,
  assertShipyardSchemaReady,
  createShipyardPool,
} from '@shipyard402/persistence-postgres';
import { JsonRpcProvider } from 'ethers';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';
import { createEgressSafeFetch } from '@shipyard402/policy-engine';
import { createFetchProtectedDeliveryClient } from '@shipyard402/protected-delivery-runner';
import { OpenAiRiskClassifier } from '@shipyard402/risk-classifier';

import { EthersErc20RefundSender, EthersNativePaymentSender, EthersRegistryAttestor, EthersToolReceiptSigner } from './ethers-adapters.js';
import { createFetchPurchaseClient } from './fetch-purchase-client.js';
import { createKuboEvidencePublisher } from './ipfs-publisher.js';
import { parseOrchestratorWorkerRuntimeConfig } from './runtime-config.js';
import { OrchestratorJobHandler, processNextOrchestratorJob } from './worker.js';

// Resolved from this file's own location, not process.cwd() -- `pnpm --filter ... dev` runs with
// cwd set to this package's directory, not the repo root, so a cwd-relative path silently broke
// under that (very standard) invocation. dist/main.js and src/main.ts are both three levels below
// the repo root (apps/orchestrator-worker/{dist,src}/main.{js,ts}), so the same ../../../ reaches it.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const egressSafeFetch = createEgressSafeFetch();

async function start(): Promise<void> {
  const config = parseOrchestratorWorkerRuntimeConfig(process.env);
  const pool = createShipyardPool({ connectionString: config.database.connectionString, useTls: config.database.useTls });

  try {
    await pool.query('SELECT 1');
    await assertShipyardSchemaReady(pool);

    const provider = new JsonRpcProvider(config.rpcUrl, config.chainId, { staticNetwork: true });
    const network = await provider.getNetwork();
    if (network.chainId !== BigInt(config.chainId)) throw new Error(`RPC chain mismatch: ${network.chainId}`);

    const signerWallet = await config.signerKeySource.loadWallet(provider);
    const toolReceiptSignerWallet = await config.toolReceiptSignerKeySource.loadWallet(provider);
    const registryAbi = JSON.parse(await readFile(
      resolve(REPO_ROOT, 'contracts/out-solc/src_ShipyardRunRegistry_sol_ShipyardRunRegistry.abi'),
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
      deliveryClient: createFetchProtectedDeliveryClient(config.demoTarget.baseUrl, {
        fetchImpl: egressSafeFetch,
        captureProviderSignature: true,
      }),
      paymentSender: new EthersNativePaymentSender(signerWallet, provider, BigInt(config.maximumProcurementSpendAtomic)),
      ...(config.refundsEnabled ? { refundSender: new EthersErc20RefundSender(signerWallet, provider) } : {}),
      purchaseClient: createFetchPurchaseClient(config.demoTarget.baseUrl, signerWallet),
      toolReceiptSigner: new EthersToolReceiptSigner(toolReceiptSignerWallet),
      evidencePackStore: new PostgresEvidencePackStore(pool),
      evidencePublisher: createKuboEvidencePublisher(config.ipfsApiUrl),
      attestor: new EthersRegistryAttestor(signerWallet, config.registryAddress, config.chainId, registryAbi),
      attestationStore: new PostgresAttestationStore(pool),
      checkpointStore: new PostgresOrchestratorCheckpointStore(pool),
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
