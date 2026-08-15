/**
 * One-off maintenance entrypoint: finds runs still awaiting payment whose deadline has already
 * passed, and moves each to the terminal EXPIRED state.
 *
 * Runs stranded before the expiry rules landed need this; going forward the payment worker's own
 * idle loop sweeps them. Dry-run by default, acts on `--apply`.
 *
 * Nothing here talks to the merchant API or the chain: expiry is decided from the deadline already
 * persisted with the run -- its order's when it has one, otherwise its quote's -- and the store's
 * own revision guard makes a payment that lands mid-flight win the race.
 */
import { PaymentReconciler } from '@shipyard402/payment-reconciliation';
import {
  PostgresPaymentReconciliationStore,
  assertShipyardSchemaReady,
  createShipyardPool,
} from '@shipyard402/persistence-postgres';

import { parsePaymentWorkerRuntimeConfig } from './runtime-config.js';

function unusable(port: string): never {
  throw new Error(`${port} is intentionally unavailable during stale-order expiry`);
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const config = parsePaymentWorkerRuntimeConfig(process.env);
  const pool = createShipyardPool({
    connectionString: config.database.connectionString,
    useTls: config.database.useTls,
  });

  try {
    await pool.query('SELECT 1');
    await assertShipyardSchemaReady(pool);

    const store = new PostgresPaymentReconciliationStore(pool);
    const stale = await store.findRunsPastPaymentDeadline(new Date(), 500);

    report('stale_runs_found', { total: stale.length });
    for (const candidate of stale) {
      report(apply ? 'will_expire' : 'would_expire', {
        runId: candidate.run.id,
        status: candidate.run.status,
        deadline: candidate.deadline,
        reason: candidate.reason,
      });
    }

    if (!apply) {
      report('dry_run_complete', { hint: 're-run with --apply to expire these runs' });
      return;
    }

    const reconciler = new PaymentReconciler({
      merchantAdapter: {
        discoverRuntimeCapabilities: () => unusable('merchantAdapter'),
        createOrder: () => unusable('merchantAdapter'),
        getOrderStatus: () => unusable('merchantAdapter'),
        getOrderProof: () => unusable('merchantAdapter'),
      },
      receiptReader: { getTransactionReceipt: () => unusable('receiptReader') },
      store,
    });

    const expired = await reconciler.sweepExpiredRuns(500);
    report('expired', { total: expired.length, runIds: expired });
  } finally {
    await pool.end();
  }
}

function report(event: string, detail: Readonly<Record<string, unknown>>): void {
  process.stdout.write(`${JSON.stringify({ event, ...detail })}\n`);
}

await main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ event: 'expire_stale_orders_failed', message: String(error) })}\n`);
  process.exitCode = 1;
});
