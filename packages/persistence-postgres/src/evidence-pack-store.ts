import type { Pool, QueryResultRow } from 'pg';

export type EvidencePack = Readonly<{
  runId: string;
  evidenceRoot: `0x${string}`;
  toolReceiptRoot: `0x${string}`;
  uri: string;
  contentHash: `0x${string}`;
  publicManifest: unknown;
  builtAt: string;
}>;

export interface EvidencePackStore {
  put(pack: EvidencePack): Promise<void>;
  getByRunId(runId: string): Promise<EvidencePack | null>;
}

type EvidencePackRow = QueryResultRow & {
  run_id: string;
  evidence_root: Buffer;
  tool_receipt_root: Buffer;
  uri: string;
  content_hash: Buffer;
  public_manifest: unknown;
  built_at: Date | string;
};

export class PostgresEvidencePackStore implements EvidencePackStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async put(pack: EvidencePack): Promise<void> {
    await this.#pool.query(
      `INSERT INTO evidence_packs (run_id, evidence_root, tool_receipt_root, uri, content_hash, public_manifest, built_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [
        pack.runId,
        hexToBuffer(pack.evidenceRoot),
        hexToBuffer(pack.toolReceiptRoot),
        pack.uri,
        hexToBuffer(pack.contentHash),
        JSON.stringify(pack.publicManifest),
        pack.builtAt,
      ],
    );
  }

  async getByRunId(runId: string): Promise<EvidencePack | null> {
    const result = await this.#pool.query<EvidencePackRow>(`SELECT * FROM evidence_packs WHERE run_id = $1`, [runId]);
    const row = result.rows[0];
    return row ? parseRow(row) : null;
  }
}

function parseRow(row: EvidencePackRow): EvidencePack {
  return {
    runId: row.run_id,
    evidenceRoot: bufferToHex(row.evidence_root),
    toolReceiptRoot: bufferToHex(row.tool_receipt_root),
    uri: row.uri,
    contentHash: bufferToHex(row.content_hash),
    publicManifest: row.public_manifest,
    builtAt: toIso(row.built_at),
  };
}

function toIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid PostgreSQL timestamp');
  return date.toISOString();
}

function hexToBuffer(value: string): Buffer {
  return Buffer.from(value.slice(2), 'hex');
}

function bufferToHex(value: Buffer): `0x${string}` {
  return `0x${value.toString('hex')}`;
}
