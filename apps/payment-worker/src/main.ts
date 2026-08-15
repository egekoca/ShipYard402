import { BotChainDirectMerchantAdapter } from '@shipyard402/bot-chain-adapter';
import type { BotChainRuntimeCapability } from '@shipyard402/bot-chain-network-config';
import { GoatFlowMerchantAdapter, type ReviewedCapabilitySource } from '@shipyard402/goat-flow-adapter';
import { createGoatReceiptReader, ViemGoatReceiptReader } from '@shipyard402/goat-chain-reader';
import type { FlowRuntimeCapability } from '@shipyard402/goat-network-config';
import { PaymentReconciler, type ChainReceiptReader } from '@shipyard402/payment-reconciliation';
import {
  createShipyardPool,
  assertShipyardSchemaReady,
  PostgresBotChainOrderContextStore,
  PostgresFlowOrderContextStore,
  PostgresPaymentReconciliationJobQueue,
  PostgresPaymentReconciliationStore,
} from '@shipyard402/persistence-postgres';
import { createPublicClient, defineChain, http } from 'viem';

import { parsePaymentWorkerRuntimeConfig } from './runtime-config.js';

/** How often the idle loop looks for runs whose payment window closed. Deadlines are minutes-scale, so this need not be tight. */
const EXPIRY_SWEEP_INTERVAL_MS = 60_000;
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

function createBotChainReceiptReader(rpcUrl: string, chainId: number): ChainReceiptReader {
  const parsed = new URL(rpcUrl);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error('BOT Chain RPC must be an HTTPS URL without embedded credentials');
  }
  const chain = defineChain({
    id: chainId,
    name: 'BOT Chain Testnet',
    nativeCurrency: { name: 'BOT', symbol: 'BOT', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const client = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 15_000, retryCount: 2 }) });
  return new ViemGoatReceiptReader(client, chainId);
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

    // Exactly one of these two branches runs per process, selected by MERCHANT_ADAPTER -- GOAT
    // Flow's construction, verification, and receipt reader are completely unchanged from before
    // BOT Chain support existed.
    let merchantAdapter: GoatFlowMerchantAdapter | BotChainDirectMerchantAdapter;
    let receiptReader: ChainReceiptReader;
    if (config.merchantAdapter === 'bot-chain-direct') {
      const botChainMerchant = config.botChainMerchant!;
      const botChainReceiptReader = createBotChainReceiptReader(
        config.botChainRpcUrl!,
        botChainMerchant.capability.chainId,
      );
      const botChainAdapter = new BotChainDirectMerchantAdapter({
        capability: botChainMerchant.capability,
        contextStore: new PostgresBotChainOrderContextStore(pool),
        receiptSource: botChainReceiptReader,
      });
      const verified = await botChainAdapter.discoverRuntimeCapabilities();
      if (verified.length !== 1 || !botChainCapabilitiesMatch(verified[0]!, botChainMerchant.capability)) {
        throw new Error('MERCHANT_CAPABILITY_VERIFICATION_FAILED');
      }
      merchantAdapter = botChainAdapter;
      receiptReader = botChainReceiptReader;
    } else {
      const merchant = config.merchant!;
      const credentials = {
        merchantId: merchant.merchantId,
        apiKey: merchant.apiKey,
        apiSecret: merchant.apiSecret,
        contextStore: new PostgresFlowOrderContextStore(pool),
        capabilitySource: new StaticReviewedCapabilitySource(merchant.capability),
      };
      const goatAdapter =
        config.goatEnvironment === 'mainnet'
          ? GoatFlowMerchantAdapter.fromMainnetCredentials(credentials)
          : GoatFlowMerchantAdapter.fromTestnet3Credentials(credentials);
      const verified = await goatAdapter.discoverRuntimeCapabilities();
      if (verified.length !== 1 || !capabilitiesMatch(verified[0]!, merchant.capability)) {
        throw new Error('MERCHANT_CAPABILITY_VERIFICATION_FAILED');
      }
      merchantAdapter = goatAdapter;
      receiptReader = createGoatReceiptReader(config.goatEnvironment!, config.rpcUrl!);
    }

    const reconciler = new PaymentReconciler({
      merchantAdapter,
      receiptReader,
      store: new PostgresPaymentReconciliationStore(pool),
    });
    const handler = new PaymentReconciliationJobHandler(reconciler);
    const queue = new PostgresPaymentReconciliationJobQueue(pool);
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());
    process.once('SIGTERM', () => controller.abort());
    process.stdout.write(`${JSON.stringify({ event: 'payment_worker_ready', workerId: config.workerId })}\n`);

    // A run abandoned at QUOTED never gets a reconciliation job, so nothing in the queue loop can
    // ever close it out. Sweeping on the idle branch keeps those from accumulating forever without
    // adding a scheduler: when there is real work to do, the queue keeps priority.
    let nextSweepAt = 0;
    while (!controller.signal.aborted) {
      const processed = await processNextPaymentJob(
        queue,
        handler,
        {
          workerId: config.workerId,
          leaseDurationSeconds: config.leaseDurationSeconds,
        },
        controller.signal,
      );
      if (processed) continue;

      if (Date.now() >= nextSweepAt) {
        nextSweepAt = Date.now() + EXPIRY_SWEEP_INTERVAL_MS;
        try {
          const expired = await reconciler.sweepExpiredRuns();
          if (expired.length > 0) {
            process.stdout.write(`${JSON.stringify({ event: 'runs_expired', runIds: expired })}\n`);
          }
        } catch (error) {
          // A failed sweep must never take the worker down: reconciliation is the primary job.
          process.stderr.write(`${JSON.stringify({ event: 'expiry_sweep_failed', message: String(error) })}\n`);
        }
      }
      await abortableDelay(config.pollIntervalMilliseconds, controller.signal);
    }
  } finally {
    await pool.end();
  }
}

function capabilitiesMatch(left: FlowRuntimeCapability, right: FlowRuntimeCapability): boolean {
  return (
    left.merchantId === right.merchantId &&
    left.chainId === right.chainId &&
    left.tokenAddress.toLowerCase() === right.tokenAddress.toLowerCase() &&
    left.receivingAddress.toLowerCase() === right.receivingAddress.toLowerCase() &&
    left.minimumAtomicAmount === right.minimumAtomicAmount &&
    left.maximumAtomicAmount === right.maximumAtomicAmount
  );
}

function botChainCapabilitiesMatch(left: BotChainRuntimeCapability, right: BotChainRuntimeCapability): boolean {
  return (
    left.merchantId === right.merchantId &&
    left.chainId === right.chainId &&
    left.tokenAddress.toLowerCase() === right.tokenAddress.toLowerCase() &&
    left.receivingAddress.toLowerCase() === right.receivingAddress.toLowerCase() &&
    left.minimumAtomicAmount === right.minimumAtomicAmount &&
    left.maximumAtomicAmount === right.maximumAtomicAmount
  );
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

await start().catch((error: unknown) => {
  // Mirrors the orchestrator worker: a bare failure code is unreadable when the process dies at
  // boot, which is exactly when the reason matters most.
  process.stderr.write(
    `${JSON.stringify({ event: 'payment_worker_stopped', code: 'SAFE_RUNTIME_FAILURE', message: String(error) })}\n`,
  );
  process.exitCode = 1;
});
