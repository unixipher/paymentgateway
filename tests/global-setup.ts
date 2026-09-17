import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

export const TEST_SCHEMA = 'gateway_test';

/**
 * Rebuilds the `gateway_test` schema from the migrations before every run. The real tables in `public`
 * are never touched. Without DATABASE_URL the database tests are skipped.
 */
export default async function setup() {
  try {
    process.loadEnvFile();
  } catch {
    // no .env
  }
  if (!process.env.DATABASE_URL) return;

  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.delete('schema');
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE; CREATE SCHEMA ${TEST_SCHEMA}; SET search_path TO ${TEST_SCHEMA};`);
    const migrations = path.join(import.meta.dirname, '..', 'prisma', 'migrations');
    const dirs = fs.readdirSync(migrations).filter((d) => fs.statSync(path.join(migrations, d)).isDirectory()).sort();
    for (const dir of dirs) {
      const sql = fs.readFileSync(path.join(migrations, dir, 'migration.sql'), 'utf8').replace(/^CREATE SCHEMA IF NOT EXISTS "public";$/m, '');
      await client.query(sql);
    }
  } finally {
    await client.end();
  }
}
