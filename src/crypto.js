import crypto from 'node:crypto';
import { config } from './config.js';

const encryptionKey = crypto.createHash('sha256').update('encrypt:' + config.sessionSecret).digest();
const signingKey = crypto.createHash('sha256').update('sign:' + config.sessionSecret).digest();

export const randomId = (prefix, bytes = 12) => `${prefix}_${crypto.randomBytes(bytes).toString('base64url')}`;

export const hmacHex = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');

export function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((b) => b.toString('base64url')).join('.');
}

export function decrypt(blob) {
  const [iv, tag, encrypted] = blob.split('.').map((part) => Buffer.from(part, 'base64url'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

export const sign = (value) => `${value}.${hmacHex(signingKey, value)}`;

export function unsign(signed) {
  const i = signed.lastIndexOf('.');
  if (i < 0) return null;
  const value = signed.slice(0, i);
  const expected = Buffer.from(hmacHex(signingKey, value));
  const actual = Buffer.from(signed.slice(i + 1));
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected) ? value : null;
}
