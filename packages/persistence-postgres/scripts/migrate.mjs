import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import pg from 'pg';

const { Pool } = pg;
const migrationDirectory = resolve(process.argv[2] ?? '../../infra/migrations');
const connectionString = process.env.DATABASE_URL ?? 'postgresql://shipyard:shipyard@127.0.0.1:5432/shipyard';
const useTls = process.env.DATABASE_TLS === 'true';
const pool = new Pool({
  connectionString,
  max: 1,
  application_name: 'shipyard402-migrator',
  statement_timeout: 60_000,
  ssl: useTls ? { rejectUnauthorized: true } : false,
});

const client = await pool.connect();
try {
  await client.query(`SELECT pg_advisory_lock(hashtext('shipyard402:schema-migrations'))`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS shipyard_schema_migrations (
      version text PRIMARY KEY,
      checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const filenames = (await readdir(migrationDirectory)).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();
  const migrations = await Promise.all(
    filenames.map(async (filename) => {
      const sql = await readFile(resolve(migrationDirectory, filename), 'utf8');
      return { filename, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    }),
  );

  await baselineEntrypointMigration(client, migrations);
  const appliedResult = await client.query(`SELECT version, checksum FROM shipyard_schema_migrations`);
  const applied = new Map(appliedResult.rows.map((row) => [row.version, row.checksum]));

  for (const migration of migrations) {
    const existingChecksum = applied.get(migration.filename);
    if (existingChecksum) {
      if (existingChecksum !== migration.checksum) {
        throw new Error(`Applied migration checksum mismatch: ${migration.filename}`);
      }
      continue;
    }

    const body = transactionBody(migration.filename, migration.sql);
    await client.query('BEGIN');
    try {
      await client.query(body);
      await client.query(`INSERT INTO shipyard_schema_migrations (version, checksum) VALUES ($1, $2)`, [
        migration.filename,
        migration.checksum,
      ]);
      await client.query('COMMIT');
      process.stdout.write(`Applied migration ${migration.filename}\n`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
} finally {
  await client.query(`SELECT pg_advisory_unlock(hashtext('shipyard402:schema-migrations'))`).catch(() => undefined);
  client.release();
  await pool.end();
}

async function baselineEntrypointMigration(client, migrations) {
  const core = migrations.find((migration) => migration.filename === '0001_core.sql');
  if (!core) throw new Error('Required migration 0001_core.sql is missing');
  const recorded = await client.query(`SELECT 1 FROM shipyard_schema_migrations WHERE version = '0001_core.sql'`);
  if (recorded.rowCount) return;

  const schema = await client.query(`
    SELECT
      to_regclass('public.organizations') IS NOT NULL AS has_organizations,
      to_regclass('public.outbox_events') IS NOT NULL AS has_outbox
  `);
  const existing = schema.rows[0];
  if (!existing?.has_organizations && !existing?.has_outbox) return;
  if (!existing?.has_organizations || !existing?.has_outbox) {
    throw new Error('Refusing to baseline a partially initialized core schema');
  }
  await client.query(`INSERT INTO shipyard_schema_migrations (version, checksum) VALUES ($1, $2)`, [
    core.filename,
    core.checksum,
  ]);
  process.stdout.write('Baselined entrypoint migration 0001_core.sql\n');
}

function transactionBody(filename, sql) {
  const trimmed = sql.trim();
  if (!/^BEGIN;\s/i.test(trimmed) || !/\sCOMMIT;$/i.test(trimmed)) {
    throw new Error(`Migration must have explicit BEGIN/COMMIT boundaries: ${filename}`);
  }
  return trimmed.replace(/^BEGIN;\s*/i, '').replace(/\s*COMMIT;$/i, '');
}
