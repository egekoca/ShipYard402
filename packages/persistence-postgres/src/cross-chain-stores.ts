import type { BnbPurchaseRecord, BnbPurchaseStore, AuthorizedBnbX402Payment } from '@shipyard402/bnb-x402-client';
import type { BridgeSubmissionRecord, BridgeSubmissionStore } from '@shipyard402/stargate-bridge-adapter';
import type { Pool, QueryResultRow } from 'pg';

type BridgeRow = QueryResultRow & {
  idempotency_key: string;
  quote_id: string;
  run_id: string;
  destination_payer: Buffer;
  minimum_amount_out_atomic: string;
  status: 'CLAIMED' | 'SUBMITTED';
  source_transaction_hash: Buffer | null;
  transfer_id: string | null;
};

export class PostgresBridgeSubmissionStore implements BridgeSubmissionStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async claim(
    record: BridgeSubmissionRecord,
  ): Promise<Readonly<{ acquired: boolean; record: BridgeSubmissionRecord }>> {
    const inserted = await this.#pool.query<BridgeRow>(
      `INSERT INTO bridge_submissions (
         idempotency_key, quote_id, run_id, destination_payer,
         minimum_amount_out_atomic, status
       ) VALUES ($1, $2, $3, $4, $5, 'CLAIMED')
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [
        record.idempotencyKey,
        record.quoteId,
        record.runId,
        addressToBuffer(record.destinationPayerAddress),
        record.minimumAmountOutAtomic,
      ],
    );
    const row = inserted.rows[0] ?? (await this.#findByIdempotencyKey(record.idempotencyKey));
    if (!row) throw new Error('Bridge submission claim disappeared');
    const persisted = parseBridgeRow(row);
    assertSameBridgeClaim(persisted, record);
    return { acquired: inserted.rowCount === 1, record: persisted };
  }

  async markSubmitted(
    idempotencyKey: string,
    result: Readonly<{ sourceTransactionHash: `0x${string}`; transferId: string }>,
  ): Promise<BridgeSubmissionRecord> {
    const updated = await this.#pool.query<BridgeRow>(
      `UPDATE bridge_submissions
       SET status = 'SUBMITTED', source_transaction_hash = $2, transfer_id = $3, updated_at = now()
       WHERE idempotency_key = $1
         AND (
           status = 'CLAIMED'
           OR (status = 'SUBMITTED' AND source_transaction_hash = $2 AND transfer_id = $3)
         )
       RETURNING *`,
      [idempotencyKey, hexToBuffer(result.sourceTransactionHash), result.transferId],
    );
    const row = updated.rows[0];
    if (!row) throw new Error('Bridge submission idempotency conflict');
    return parseBridgeRow(row);
  }

  async abandonClaim(idempotencyKey: string): Promise<void> {
    await this.#pool.query(`DELETE FROM bridge_submissions WHERE idempotency_key = $1 AND status = 'CLAIMED'`, [
      idempotencyKey,
    ]);
  }

  async findByTransferId(transferId: string): Promise<BridgeSubmissionRecord | null> {
    const result = await this.#pool.query<BridgeRow>(`SELECT * FROM bridge_submissions WHERE transfer_id = $1`, [
      transferId,
    ]);
    return result.rows[0] ? parseBridgeRow(result.rows[0]) : null;
  }

  async #findByIdempotencyKey(idempotencyKey: string): Promise<BridgeRow | null> {
    const result = await this.#pool.query<BridgeRow>(`SELECT * FROM bridge_submissions WHERE idempotency_key = $1`, [
      idempotencyKey,
    ]);
    return result.rows[0] ?? null;
  }
}

type AuthorizationRow = QueryResultRow & {
  idempotency_key: string;
  amount_atomic: string;
  status: 'CLAIMED' | 'AUTHORIZED';
  payment_receipt: string | null;
  payment_proof_hash: Buffer | null;
};

export class PostgresBnbPurchaseStore implements BnbPurchaseStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async claim(record: BnbPurchaseRecord): Promise<Readonly<{ acquired: boolean; record: BnbPurchaseRecord }>> {
    const inserted = await this.#pool.query<AuthorizationRow>(
      `INSERT INTO bnb_x402_authorizations (idempotency_key, amount_atomic, status)
       VALUES ($1, $2, 'CLAIMED')
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [record.idempotencyKey, record.amountAtomic],
    );
    const row = inserted.rows[0] ?? (await this.#find(record.idempotencyKey));
    if (!row) throw new Error('BNB x402 authorization claim disappeared');
    const persisted = parseAuthorizationRow(row);
    if (persisted.amountAtomic !== record.amountAtomic) throw new Error('BNB x402 idempotency amount conflict');
    return { acquired: inserted.rowCount === 1, record: persisted };
  }

  async markAuthorized(idempotencyKey: string, payment: AuthorizedBnbX402Payment): Promise<BnbPurchaseRecord> {
    const updated = await this.#pool.query<AuthorizationRow>(
      // amount_atomic is overwritten with what actually settled: the claim reserved a ceiling,
      // and the price only becomes known once the target's challenge has been read.
      `UPDATE bnb_x402_authorizations
       SET status = 'AUTHORIZED', amount_atomic = $4, payment_receipt = $2, payment_proof_hash = $3,
           updated_at = now()
       WHERE idempotency_key = $1
         AND (
           status = 'CLAIMED'
           OR (status = 'AUTHORIZED' AND payment_receipt = $2 AND payment_proof_hash = $3)
         )
       RETURNING *`,
      [idempotencyKey, payment.paymentReceipt, hexToBuffer(payment.paymentProofHash), payment.amountAtomic],
    );
    const row = updated.rows[0];
    if (!row) throw new Error('BNB x402 authorization idempotency conflict');
    return parseAuthorizationRow(row);
  }

  async abandonClaim(idempotencyKey: string): Promise<void> {
    await this.#pool.query(`DELETE FROM bnb_x402_authorizations WHERE idempotency_key = $1 AND status = 'CLAIMED'`, [
      idempotencyKey,
    ]);
  }

  async #find(idempotencyKey: string): Promise<AuthorizationRow | null> {
    const result = await this.#pool.query<AuthorizationRow>(
      `SELECT * FROM bnb_x402_authorizations WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    return result.rows[0] ?? null;
  }
}

function parseBridgeRow(row: BridgeRow): BridgeSubmissionRecord {
  return {
    status: row.status,
    idempotencyKey: row.idempotency_key,
    quoteId: row.quote_id,
    runId: row.run_id,
    destinationPayerAddress: bufferToAddress(row.destination_payer),
    minimumAmountOutAtomic: row.minimum_amount_out_atomic,
    ...(row.source_transaction_hash ? { sourceTransactionHash: bufferToHash(row.source_transaction_hash) } : {}),
    ...(row.transfer_id ? { transferId: row.transfer_id } : {}),
  };
}

function parseAuthorizationRow(row: AuthorizationRow): BnbPurchaseRecord {
  return {
    status: row.status,
    idempotencyKey: row.idempotency_key,
    amountAtomic: row.amount_atomic,
    ...(row.payment_receipt ? { paymentReceipt: row.payment_receipt } : {}),
    ...(row.payment_proof_hash ? { paymentProofHash: bufferToHash(row.payment_proof_hash) } : {}),
  };
}

function assertSameBridgeClaim(persisted: BridgeSubmissionRecord, requested: BridgeSubmissionRecord): void {
  if (
    persisted.quoteId !== requested.quoteId ||
    persisted.runId !== requested.runId ||
    persisted.destinationPayerAddress.toLowerCase() !== requested.destinationPayerAddress.toLowerCase() ||
    persisted.minimumAmountOutAtomic !== requested.minimumAmountOutAtomic
  ) {
    throw new Error('Bridge submission idempotency claim conflict');
  }
}

function addressToBuffer(value: string): Buffer {
  if (!/^0x[a-fA-F0-9]{40}$/.test(value)) throw new Error('Invalid EVM address');
  return Buffer.from(value.slice(2), 'hex');
}

function hexToBuffer(value: string): Buffer {
  if (!/^0x[a-fA-F0-9]{64}$/.test(value)) throw new Error('Invalid transaction hash');
  return Buffer.from(value.slice(2), 'hex');
}

function bufferToHash(value: Buffer): `0x${string}` {
  return `0x${value.toString('hex')}`;
}

function bufferToAddress(value: Buffer): `0x${string}` {
  return `0x${value.toString('hex')}`;
}
