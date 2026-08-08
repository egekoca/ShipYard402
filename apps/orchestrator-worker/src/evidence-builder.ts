import {
  buildToolReceiptRoot,
  hashToolReceipt,
  type ToolReceipt,
  type UnsignedToolReceipt,
} from '@shipyard402/evidence-sdk';
import type { ReplayEvidence } from '@shipyard402/protected-delivery-runner';
import { keccak256, toUtf8Bytes } from 'ethers';

export type ToolReceiptInput = Readonly<{
  runId: string;
  toolAgentId: string;
  targetAgentId: string;
  targetVersionHash: `0x${string}`;
  policyHash: `0x${string}`;
  chainTransactionHash: `0x${string}`;
  chainId: number;
  startedAt: number;
  completedAt: number;
  toolVersion: string;
}>;

export function buildUnsignedToolReceipt(evidence: ReplayEvidence, input: ToolReceiptInput): UnsignedToolReceipt {
  const initialAttempt = evidence.attempts[0];
  if (!initialAttempt?.responseHash) {
    throw new Error('Cannot build a tool receipt without an initial delivery response hash');
  }
  return {
    receiptVersion: '1.0',
    runId: input.runId,
    toolAgentId: input.toolAgentId,
    targetAgentId: input.targetAgentId,
    targetVersionHash: input.targetVersionHash,
    policyHash: input.policyHash,
    scenarioId: evidence.scenarioId,
    requestHash: initialAttempt.requestHash,
    responseHash: initialAttempt.responseHash,
    paymentProofHash: keccak256(toUtf8Bytes(input.chainTransactionHash)) as `0x${string}`,
    chainTransactionHash: input.chainTransactionHash,
    chainId: input.chainId,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    result: evidence.result,
    failureCode: evidence.result === 'PASS' ? '' : (evidence.failureCode ?? 'UNKNOWN'),
    toolVersion: input.toolVersion,
    signatureScheme: 'EIP712',
  };
}

/** The AI's raw, pre-compilation proposal -- advisory only, see compileTestPlan in risk-classifier. */
export type AiRiskProposal = Readonly<{
  riskLevel: string;
  proposedScenarios: readonly string[];
  proposedToolBudgetAtomic: string;
  rationale: string;
}>;

/** One tool-agent-to-target-agent exchange per scenario probe, already-hashed (no raw bodies). */
export type ScenarioTrace = Readonly<{
  scenarioId: string;
  attempts: readonly Readonly<{
    phase: 'INITIAL' | 'REPLAY';
    requestHash: `0x${string}`;
    responseHash?: `0x${string}`;
    statusCode?: number;
    deliveryConfirmed?: boolean;
  }>[];
}>;

export type EvidencePackContent = Readonly<{
  runId: string;
  targetServiceId: string;
  targetVersionHash: `0x${string}`;
  policyHash: `0x${string}`;
  riskLevel: string;
  rationale: string;
  toolBudgetAtomic: string;
  /** Absent when resumed from a checkpoint written before this field existed. */
  aiProposal?: AiRiskProposal;
  scenarios: readonly string[];
  scenarioTraces: readonly ScenarioTrace[];
  result: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
  toolReceipts: readonly ToolReceipt[];
}>;

export type BuiltEvidencePack = Readonly<{
  evidenceRoot: `0x${string}`;
  toolReceiptRoot: `0x${string}`;
  contentHash: `0x${string}`;
  publicManifest: EvidencePackContent;
}>;

export function buildEvidencePack(content: EvidencePackContent): BuiltEvidencePack {
  if (content.toolReceipts.length === 0) throw new Error('An evidence pack requires at least one tool receipt');
  const toolReceiptRoot = buildToolReceiptRoot(content.toolReceipts.map((receipt) => hashToolReceipt(receipt)));
  const evidenceRoot = keccak256(
    toUtf8Bytes(
      canonicalJson({
        runId: content.runId,
        toolReceiptRoot,
        result: content.result,
        scenarios: content.scenarios,
        targetVersionHash: content.targetVersionHash,
        policyHash: content.policyHash,
      }),
    ),
  ) as `0x${string}`;
  const contentHash = keccak256(toUtf8Bytes(canonicalJson(content))) as `0x${string}`;

  return { evidenceRoot, toolReceiptRoot, contentHash, publicManifest: content };
}

/**
 * The exact bytes contentHash is computed over -- publishing this to IPFS means anyone can
 * fetch the content, canonicalize it the same way, and check it against the on-chain contentHash.
 */
export function canonicalEvidencePackContent(content: EvidencePackContent): string {
  return canonicalJson(content);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}
