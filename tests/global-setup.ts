import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Rebuilds an isolated local SQLite database before every run. The user's configured database is
 * never opened or modified.
 */
export default async function setup() {
  const root = path.join(import.meta.dirname, '..');
  const database = path.join(root, 'data', 'test.db');
  fs.rmSync(database, { force: true });
  fs.rmSync(`${database}-journal`, { force: true });
  fs.closeSync(fs.openSync(database, 'w'));
  execFileSync(path.join(root, 'node_modules', '.bin', 'prisma'), ['db', 'push'], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: 'file:./data/test.db' },
    stdio: 'pipe',
  });
}
