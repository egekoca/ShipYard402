import { GoatFlowMerchantAdapter, type ReviewedCapabilitySource } from '@shipyard402/goat-flow-adapter';
import { createGoatReceiptReader } from '@shipyard402/goat-chain-reader';
import type { FlowRuntimeCapability } from '@shipyard402/goat-network-config';
import { PaymentReconciler } from '@shipyard402/payment-reconciliation';
import {
  createShipyardPool,
  assertShipyardSchemaReady,
  PostgresFlowOrderContextStore,
  PostgresPaymentReconciliationJobQueue,
  PostgresPaymentReconciliationStore,
} from '@shipyard402/persistence-postgres';

import { parsePaymentWorkerRuntimeConfig } from './runtime-config.js';
import { PaymentReconciliationJobHandler, processNextPaymentJob } from './worker.js';

class StaticReviewedCapabilitySource implements ReviewedCapabilitySource {
  readonly #capability: FlowRuntimeCapability;

  constructor(capability: FlowRuntimeCapability) {
    this.#capability = capability;
  }

  async loadReviewedCapabilities(): Promise<readonly FlowRuntimeCapability[]> {
    return [this.#capability];
  }
}

async function start(): Promise<void> {
  const config = parsePaymentWorkerRuntimeConfig(process.env);
  const pool = createShipyardPool({
    connectionString: config.database.connectionString,
    useTls: config.database.useTls,
  });
  try {
    await pool.query('SELECT 1');
    await assertShipyardSchemaReady(pool);
    const credentials = {
      merchantId: config.merchant.merchantId,
      apiKey: config.merchant.apiKey,
      apiSecret: config.merchant.apiSecret,
      contextStore: new PostgresFlowOrderContextStore(pool),
      capabilitySource: new StaticReviewedCapabilitySource(config.merchant.capability),
    };
    const adapter = config.goatEnvironment === 'mainnet'
      ? GoatFlowMerchantAdapter.fromMainnetCredentials(credentials)
      : GoatFlowMerchantAdapter.fromTestnet3Credentials(credentials);
    const verified = await adapter.discoverRuntimeCapabilities();
    if (verified.length !== 1 || !capabilitiesMatch(verified[0]!, config.merchant.capability)) {
      throw new Error('MERCHANT_CAPABILITY_VERIFICATION_FAILED');
    }

    const handler = new PaymentReconciliationJobHandler(new PaymentReconciler({
      merchantAdapter: adapter,
      receiptReader: createGoatReceiptReader(config.goatEnvironment, config.rpcUrl),
      store: new PostgresPaymentReconciliationStore(pool),
    }));
    const queue = new PostgresPaymentReconciliationJobQueue(pool);
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());
    process.once('SIGTERM', () => controller.abort());
    process.stdout.write(JSON.stringify({ event: 'payment_worker_ready', workerId: config.workerId }) + '\n');

    while (!controller.signal.aborted) {
      const processed = await processNextPaymentJob(queue, handler, {
        workerId: config.workerId,
        leaseDurationSeconds: config.leaseDurationSeconds,
      }, controller.signal);
      if (!processed) await abortableDelay(config.pollIntervalMilliseconds, controller.signal);
    }
  } finally {
    await pool.end();
  }
}

function capabilitiesMatch(left: FlowRuntimeCapability, right: FlowRuntimeCapability): boolean {
  return left.merchantId === right.merchantId &&
    left.chainId === right.chainId &&
    left.tokenAddress.toLowerCase() === right.tokenAddress.toLowerCase() &&
    left.receivingAddress.toLowerCase() === right.receivingAddress.toLowerCase() &&
    left.minimumAtomicAmount === right.minimumAtomicAmount &&
    left.maximumAtomicAmount === right.maximumAtomicAmount;
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(done, milliseconds);
    signal.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timeout);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}

await start().catch(() => {
  process.stderr.write(JSON.stringify({ event: 'payment_worker_stopped', code: 'SAFE_RUNTIME_FAILURE' }) + '\n');
  process.exitCode = 1;
});
