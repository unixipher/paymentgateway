/**
 * One-off upgrade from the Express version. Run once, right after `npm run db:migrate`:
 *
 *   node --env-file=.env scripts/migrate-legacy-secrets.ts
 *
 * Needs SESSION_SECRET (the old key) and ENCRYPTION_KEY (the new one). It re-encrypts Gmail refresh
 * tokens with ENCRYPTION_KEY and encrypts webhook secrets, which used to be stored in plain text.
 * Safe to run more than once: values already in the new format are skipped. Delete this file afterwards.
 */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import pg from 'pg';

const { DATABASE_URL, SESSION_SECRET, ENCRYPTION_KEY } = process.env;
if (!DATABASE_URL || !SESSION_SECRET || !ENCRYPTION_KEY) {
  throw new Error('DATABASE_URL, SESSION_SECRET (old) and ENCRYPTION_KEY (new) must be set');
}

const legacyKey = createHash('sha256').update(`encrypt:${SESSION_SECRET}`).digest();
// Must match src/lib/crypto.ts.
const newKey = Buffer.from(hkdfSync('sha256', Buffer.from(ENCRYPTION_KEY, 'base64'), Buffer.alloc(0), 'paymentgateway:encryption', 32));

function legacyDecrypt(blob: string): string {
  const [iv, tag, encrypted] = blob.split('.').map((part) => Buffer.from(part, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', legacyKey, iv!);
  decipher.setAuthTag(tag!);
  return Buffer.concat([decipher.update(encrypted!), decipher.final()]).toString('utf8');
}

function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', newKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', ...[iv, cipher.getAuthTag(), encrypted].map((b) => b.toString('base64url'))].join('.');
}

const url = new URL(DATABASE_URL);
const schema = url.searchParams.get('schema') ?? 'public';
url.searchParams.delete('schema');
const client = new pg.Client({ connectionString: url.toString() });
await client.connect();

try {
  await client.query('BEGIN');
  const { rows } = await client.query<{ id: string; gmail_refresh_token: string | null; webhook_secret: string }>(
    `SELECT id, gmail_refresh_token, webhook_secret FROM "${schema}".merchants FOR UPDATE`,
  );
  let updated = 0;
  for (const row of rows) {
    let refreshToken = row.gmail_refresh_token;
    if (refreshToken && !refreshToken.startsWith('v1.')) {
      try {
        refreshToken = encrypt(legacyDecrypt(refreshToken));
      } catch {
        console.warn(`${row.id}: could not decrypt the old Gmail token (wrong SESSION_SECRET?), disconnecting Gmail`);
        refreshToken = null;
      }
    }
    const webhookSecret = row.webhook_secret.startsWith('v1.') ? row.webhook_secret : encrypt(row.webhook_secret);
    if (refreshToken !== row.gmail_refresh_token || webhookSecret !== row.webhook_secret) {
      await client.query(
        `UPDATE "${schema}".merchants SET gmail_refresh_token = $1, webhook_secret = $2 WHERE id = $3`,
        [refreshToken, webhookSecret, row.id],
      );
      updated++;
    }
  }
  await client.query('COMMIT');
  console.log(`Merchants checked: ${rows.length}, updated: ${updated}`);
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  await client.end();
}
