import type { Pool, QueryResultRow } from 'pg';

export type AttestationRecord = Readonly<{
  runId: string;
  registryAddress: `0x${string}`;
  chainId: number;
  transactionHash: `0x${string}`;
  attestor: `0x${string}`;
  expiresAt: string;
  submittedAt: string;
}>;

export interface AttestationStore {
  put(record: AttestationRecord): Promise<void>;
  getByRunId(runId: string): Promise<AttestationRecord | null>;
}

type AttestationRow = QueryResultRow & {
  run_id: string;
  registry_address: Buffer;
  chain_id: string;
  transaction_hash: Buffer;
  attestor: Buffer;
  expires_at: Date | string;
  submitted_at: Date | string;
};

export class PostgresAttestationStore implements AttestationStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async put(record: AttestationRecord): Promise<void> {
    await this.#pool.query(
      `INSERT INTO attestations (run_id, registry_address, chain_id, transaction_hash, attestor, expires_at, submitted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        record.runId,
        hexToBuffer(record.registryAddress),
        record.chainId,
        hexToBuffer(record.transactionHash),
        hexToBuffer(record.attestor),
        record.expiresAt,
        record.submittedAt,
      ],
    );
  }

  async getByRunId(runId: string): Promise<AttestationRecord | null> {
    const result = await this.#pool.query<AttestationRow>(
      `SELECT * FROM attestations WHERE run_id = $1`,
      [runId],
    );
    const row = result.rows[0];
    return row ? parseRow(row) : null;
  }
}

function parseRow(row: AttestationRow): AttestationRecord {
  return {
    runId: row.run_id,
    registryAddress: bufferToHex(row.registry_address),
    chainId: Number(row.chain_id),
    transactionHash: bufferToHex(row.transaction_hash),
    attestor: bufferToHex(row.attestor),
    expiresAt: toIso(row.expires_at),
    submittedAt: toIso(row.submitted_at),
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
