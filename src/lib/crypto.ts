import {
  createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual,
} from 'node:crypto';
import { config } from './env';

const derivedKeys = new Map<string, Buffer>();

/** Independent sub-keys for each purpose, derived from ENCRYPTION_KEY. */
function key(purpose: 'encryption' | 'signing'): Buffer {
  let derived = derivedKeys.get(purpose);
  if (!derived) {
    derived = Buffer.from(hkdfSync('sha256', config().encryptionKey, Buffer.alloc(0), `paymentgateway:${purpose}`, 32));
    derivedKeys.set(purpose, derived);
  }
  return derived;
}

export const randomId = (prefix: string, bytes = 12) => `${prefix}_${randomBytes(bytes).toString('base64url')}`;

/** High-entropy secret token, e.g. `pgs_...` for sessions or `pgk_live_...` for API keys. */
export const randomToken = (prefix: string) => `${prefix}_${randomBytes(32).toString('base64url')}`;

export const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');

export const hmacSha256Hex = (secret: string | Buffer, data: string) =>
  createHmac('sha256', secret).update(data).digest('hex');

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

const VERSION = 'v1';

/** AES-256-GCM. Output: `v1.<iv>.<tag>.<ciphertext>` (base64url). */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key('encryption'), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [VERSION, iv, cipher.getAuthTag(), encrypted]
    .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
    .join('.');
}

export function decrypt(blob: string): string {
  const [version, iv, tag, encrypted] = blob.split('.');
  if (version !== VERSION || !iv || !tag || !encrypted) throw new Error('Unsupported ciphertext format');
  const decipher = createDecipheriv('aes-256-gcm', key('encryption'), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8');
}

/** Tamper-proof (not secret) value, e.g. for the OAuth state cookie. */
export const sign = (value: string) => `${value}.${hmacSha256Hex(key('signing'), value)}`;

export function unsign(signed: string): string | null {
  const i = signed.lastIndexOf('.');
  if (i < 0) return null;
  const value = signed.slice(0, i);
  return safeEqual(signed.slice(i + 1), hmacSha256Hex(key('signing'), value)) ? value : null;
}
