import type { OrchestratorRunCheckpoint } from '@shipyard402/persistence-postgres';
import type { Quote } from '@shipyard402/quote-engine';

import { buildAttestationInput } from '../attestation-builder.js';
import type { buildEvidencePack } from '../evidence-builder.js';
import type { OrchestratorPipelineDependencies } from './types.js';

/** ATTESTING: submit the on-chain attestation once (the registry reverts a second submission for the same run) and record it locally. */
export async function runAttestationPhase(
  deps: OrchestratorPipelineDependencies,
  runId: string,
  checkpoint: OrchestratorRunCheckpoint,
  quote: Quote,
  targetVersionHash: `0x${string}`,
  policyHash: `0x${string}`,
  customerPaymentProofHash: `0x${string}`,
  customerPaymentAtomic: string,
  evidencePack: ReturnType<typeof buildEvidencePack>,
  evidenceURI: string,
  purchaseAmount: bigint,
  completedAt: number,
  overallResult: 'PASS' | 'FAIL' | 'INCONCLUSIVE',
  now: () => Date,
): Promise<Readonly<{ attestationTransactionHash: `0x${string}` }>> {
  const attestationInput = buildAttestationInput({
    runId,
    targetAgentId: quote.request.targetAgentId,
    targetServiceId: quote.request.targetServiceId,
    targetVersionHash,
    policyHash,
    customerPaymentProofHash,
    toolReceiptRoot: evidencePack.toolReceiptRoot,
    evidenceRoot: evidencePack.evidenceRoot,
    evidenceURI,
    requester: quote.request.requesterAddress as `0x${string}`,
    shipyardAgent: deps.attestor.address,
    customerPaymentToken: quote.capabilitySnapshot.tokenAddress as `0x${string}`,
    toolSpendAtomic: purchaseAmount,
    customerPaymentAtomic: BigInt(customerPaymentAtomic),
    completedAt,
    result: overallResult,
  });
  // The registry is append-only and will revert a second attestation for the same run, so a
  // resumed attempt must reuse a checkpointed submission rather than resubmitting.
  let attestationTransactionHash = checkpoint.attestationTransactionHash;
  if (!attestationTransactionHash) {
    attestationTransactionHash = await deps.attestor.submit(attestationInput);
    await deps.checkpointStore.merge(runId, { attestationTransactionHash });
  }
  if (!(await deps.attestationStore.getByRunId(runId))) {
    await deps.attestationStore.put({
      runId,
      registryAddress: deps.attestor.registryAddress,
      chainId: deps.attestor.chainId,
      transactionHash: attestationTransactionHash,
      attestor: deps.attestor.address,
      expiresAt: new Date(attestationInput.expiresAt * 1_000).toISOString(),
      submittedAt: now().toISOString(),
    });
  }
  return { attestationTransactionHash };
}
