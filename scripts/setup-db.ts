import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

try {
  process.loadEnvFile();
} catch {
  // .env is optional; local SQLite has a safe default.
}

const root = path.join(import.meta.dirname, '..');
const databaseUrl = process.env.DATABASE_URL || 'file:./data/paymentgateway.db';
if (!databaseUrl.startsWith('file:')) throw new Error('DATABASE_URL must point to a local SQLite file');

const rawPath = databaseUrl.slice('file:'.length);
const databasePath = rawPath.startsWith('/') ? fileURLToPath(databaseUrl) : path.resolve(root, rawPath);
fs.mkdirSync(path.dirname(databasePath), { recursive: true });
if (!fs.existsSync(databasePath)) fs.closeSync(fs.openSync(databasePath, 'w'));

// `db push` is intentionally used for this single-node, self-hosted SQLite app.
// It also adopts databases created before migration history was introduced,
// avoiding P3005 without deleting any local data.
execFileSync(path.join(root, 'node_modules', '.bin', 'prisma'), ['db', 'push'], {
  cwd: root,
  env: { ...process.env, DATABASE_URL: databaseUrl },
  stdio: 'inherit',
});

console.log(`Local SQLite database ready: ${databasePath}`);
