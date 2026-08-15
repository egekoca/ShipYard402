/**
 * One-off maintenance entrypoint: finds funded runs whose orchestrator job dead-lettered and which
 * were consequently left stranded at whatever status they failed at, and drives each one to a
 * terminal DELIVERED_INCONCLUSIVE with evidence and an on-chain attestation.
 *
 * Runs that pre-date the fix in worker.ts need this; new dead letters finalize themselves. It is
 * dry-run by default and only acts when passed `--apply`, because attesting is irreversible: the
 * registry is append-only.
 *
 * Every dependency that could spend money is deliberately a throwing stub. Finalization never
 * procures, never pays a target, and never calls the model, so wiring those ports for real would
 * only widen what a maintenance run could do by accident.
 */
import {
  PostgresAttestationStore,
  PostgresEvidencePackStore,
  PostgresOrchestratorCheckpointStore,
  PostgresQuoteRepository,
  PostgresRunRepository,
  assertShipyardSchemaReady,
  createShipyardPool,
} from '@shipyard402/persistence-postgres';
import { JsonRpcProvider } from 'ethers';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EthersRegistryAttestor, EthersToolReceiptSigner } from './ethers-adapters.js';
import { createKuboEvidencePublisher } from './ipfs-publisher.js';
import { finalizeRunAsInconclusive } from './pipeline.js';
import type { OrchestratorPipelineDependencies } from './pipeline.js';
import { parseOrchestratorWorkerRuntimeConfig } from './runtime-config.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Dead-letter reasons this script will finalize. The two ambiguous-settlement reasons are absent
 * on purpose: money may or may not have moved, and attesting a verdict over an unknown money state
 * writes an unretractable claim. Those stay for a human who has checked the chain.
 *
 * STALE_LEASE_ATTEMPTS_EXHAUSTED belongs here and nowhere else. It is the one dead-letter reason
 * written by the queue's own sweep (see PostgresOrchestratorJobQueue.claimNext) rather than by the
 * job handler, so it never passes through OrchestratorJobHandler's #deadLetter and never
 * self-finalizes the way every handler-produced dead letter does. Without it in this set a funded
 * run whose worker hard-crashed while holding the lease on its final attempt has no path to a
 * verdict at all -- neither automatic nor manual -- which is exactly what docs/state-machine.md
 * forbids after FUNDED. Its money exposure is the same as PIPELINE_RETRIES_EXHAUSTED above (the
 * pipeline ran out of attempts), not the ambiguous-send case, so it is safe to finalize from
 * checkpoints.
 */
const FINALIZABLE_REASONS = new Set([
  'PIPELINE_RETRIES_EXHAUSTED',
  'PROCUREMENT_DENIED',
  'UNEXPECTED_RUN_STATE',
  'STALE_LEASE_ATTEMPTS_EXHAUSTED',
]);

type StrandedRun = Readonly<{ runId: string; status: string; reason: string }>;

function unusable(port: string): never {
  throw new Error(`${port} is intentionally unavailable during stuck-run finalization`);
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const config = parseOrchestratorWorkerRuntimeConfig(process.env);
  const pool = createShipyardPool({
    connectionString: config.database.connectionString,
    useTls: config.database.useTls,
  });

  try {
    await pool.query('SELECT 1');
    await assertShipyardSchemaReady(pool);

    const stranded = await pool.query<{ run_id: string; status: string; last_error_code: string | null }>(
      `SELECT r.id AS run_id, r.status, j.last_error_code
         FROM runs r
         JOIN orchestrator_jobs j ON j.run_id = r.id
        WHERE j.status = 'DEAD_LETTER'
          AND r.status NOT IN (
            'DELIVERED_PASS', 'DELIVERED_CONDITIONAL', 'DELIVERED_FAIL', 'DELIVERED_INCONCLUSIVE',
            'CANCELLED', 'EXPIRED'
          )
        ORDER BY r.created_at`,
    );

    const candidates: StrandedRun[] = [];
    const skipped: StrandedRun[] = [];
    for (const row of stranded.rows) {
      const entry: StrandedRun = { runId: row.run_id, status: row.status, reason: row.last_error_code ?? 'UNKNOWN' };
      (FINALIZABLE_REASONS.has(entry.reason) ? candidates : skipped).push(entry);
    }

    report('stranded_runs_found', { total: stranded.rowCount ?? 0, finalizable: candidates.length });
    for (const entry of skipped) {
      report('skipped_needs_manual_reconciliation', entry);
    }
    for (const entry of candidates) {
      report(apply ? 'will_finalize' : 'would_finalize', entry);
    }

    if (!apply) {
      report('dry_run_complete', { hint: 're-run with --apply to finalize; this submits on-chain attestations' });
      return;
    }
    if (candidates.length === 0) return;

    const provider = new JsonRpcProvider(config.rpcUrl, config.chainId, { staticNetwork: true });
    const network = await provider.getNetwork();
    if (network.chainId !== BigInt(config.chainId)) throw new Error(`RPC chain mismatch: ${network.chainId}`);

    const signerWallet = await config.signerKeySource.loadWallet(provider);
    const toolReceiptSignerWallet = await config.toolReceiptSignerKeySource.loadWallet(provider);
    const registryAbi = JSON.parse(
      await readFile(
        resolve(REPO_ROOT, 'contracts/out-solc/src_ShipyardRunRegistry_sol_ShipyardRunRegistry.abi'),
        'utf8',
      ),
    );

    const deps: OrchestratorPipelineDependencies = {
      runRepository: new PostgresRunRepository(pool),
      quoteRepository: new PostgresQuoteRepository(pool),
      riskClassifier: { classify: () => unusable('riskClassifier') },
      mandatoryScenarios: config.mandatoryScenarios,
      shipyardAgentId: config.shipyardAgentId,
      homeChainId: config.chainId,
      demoTarget: { ...config.demoTarget, chainId: config.chainId },
      // Empty on purpose: this entrypoint finalizes stranded runs and must never procure, so it is
      // allowed to sign an authorization for nothing at all. The payer below throws anyway.
      procurementAllowedAssets: [],
      deliveryClientFor: () => unusable('deliveryClient'),
      x402Payer: { payerAddress: signerWallet.address as `0x${string}`, acquire: () => unusable('x402Payer') },
      toolReceiptSigner: new EthersToolReceiptSigner(toolReceiptSignerWallet),
      evidencePackStore: new PostgresEvidencePackStore(pool),
      evidencePublisher: createKuboEvidencePublisher(config.ipfsApiUrl),
      attestor: new EthersRegistryAttestor(signerWallet, config.registryAddress, config.chainId, registryAbi),
      attestationStore: new PostgresAttestationStore(pool),
      checkpointStore: new PostgresOrchestratorCheckpointStore(pool),
    };

    for (const entry of candidates) {
      try {
        const result = await finalizeRunAsInconclusive(entry.runId, deps, entry.reason);
        report(result ? 'finalized' : 'no_action_needed', { ...entry, ...(result ?? {}) });
      } catch (error) {
        report('finalize_failed', { ...entry, message: String(error) });
      }
    }
  } finally {
    await pool.end();
  }
}

function report(event: string, detail: Readonly<Record<string, unknown>>): void {
  process.stdout.write(`${JSON.stringify({ event, ...detail })}\n`);
}

await main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ event: 'finalize_stuck_runs_failed', message: String(error) })}\n`);
  process.exitCode = 1;
});
