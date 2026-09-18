import type { NextRequest } from 'next/server';
import type { Merchant } from '@/generated/prisma/client';
import { randomId, randomToken, sha256Hex } from './crypto';
import { prisma } from './db';
import { config } from './env';
import { unauthorized } from './errors';

export const SESSION_TOKEN_PREFIX = 'pgs';
export const API_KEY_PREFIX = 'pgk_live';
export const LOGIN_CODE_PREFIX = 'pgc';
export const DEVICE_TOKEN_PREFIX = 'pgd';

export type AuthMethod = 'session' | 'api_key';

export interface Principal {
  merchant: Merchant;
  method: AuthMethod;
  sessionId?: string;
}

export const bearerToken = (req: NextRequest) => req.headers.get('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1];

/** Resolves the merchant behind the request's `Authorization: Bearer` token, or throws 401. */
export async function authenticate(req: NextRequest, allow: AuthMethod[]): Promise<Principal> {
  const token = bearerToken(req);
  if (!token) throw unauthorized();

  if (token.startsWith(`${SESSION_TOKEN_PREFIX}_`) && allow.includes('session')) {
    const session = await prisma.session.findUnique({ where: { tokenHash: sha256Hex(token) }, include: { merchant: true } });
    // The merchant can be missing if the account is deleted while this request is in flight.
    if (!session?.merchant || session.expiresAt.getTime() < Date.now()) throw unauthorized('Session expired, sign in again');
    // Only write lastUsedAt occasionally, not on every request.
    if (Date.now() - session.lastUsedAt.getTime() > 5 * 60_000) {
      await prisma.session.update({ where: { id: session.id }, data: { lastUsedAt: new Date() } });
    }
    return { merchant: session.merchant, method: 'session', sessionId: session.id };
  }

  if (token.startsWith(`${API_KEY_PREFIX}_`) && allow.includes('api_key')) {
    const merchant = await prisma.merchant.findUnique({ where: { apiKeyHash: sha256Hex(token) } });
    if (!merchant) throw unauthorized('Invalid API key');
    return { merchant, method: 'api_key' };
  }

  throw unauthorized(allow.includes('api_key') ? 'Missing or invalid credentials' : 'This endpoint requires a dashboard session');
}

export async function createLoginCode(merchantId: string, redirectPath: string | null): Promise<string> {
  const code = randomToken(LOGIN_CODE_PREFIX);
  await prisma.loginCode.create({
    data: {
      codeHash: sha256Hex(code),
      merchantId,
      redirectPath,
      expiresAt: new Date(Date.now() + config().loginCodeTtlMs),
    },
  });
  return code;
}

/** Single use: the code is deleted as it is redeemed, so a replayed code always fails. */
export async function redeemLoginCode(code: string, userAgent: string | null) {
  const deleted = await prisma.loginCode
    .delete({ where: { codeHash: sha256Hex(code) } })
    .catch(() => null);
  if (!deleted || deleted.expiresAt.getTime() < Date.now()) throw unauthorized('Login code is invalid or expired, sign in again');

  const token = randomToken(SESSION_TOKEN_PREFIX);
  const session = await prisma.session.create({
    data: {
      id: randomId('ses'),
      merchantId: deleted.merchantId,
      tokenHash: sha256Hex(token),
      userAgent: userAgent?.slice(0, 300) ?? null,
      expiresAt: new Date(Date.now() + config().sessionTtlMs),
    },
    include: { merchant: true },
  });
  return { token, session, redirectPath: deleted.redirectPath };
}

export async function revokeSession(sessionId: string) {
  await prisma.session.deleteMany({ where: { id: sessionId } });
}

export function generateApiKey() {
  const key = randomToken(API_KEY_PREFIX);
  return { key, hash: sha256Hex(key), prefix: key.slice(0, API_KEY_PREFIX.length + 5) };
}
