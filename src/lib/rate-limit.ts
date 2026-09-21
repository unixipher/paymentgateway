import { prisma } from './db';
import { ApiError } from './errors';

/**
 * Fixed-window rate limit stored in the local SQLite database.
 * Throws a 429 with Retry-After once `limit` requests for `key` have been made in the current window.
 */
export async function rateLimit(key: string, limit: number, windowMs: number): Promise<void> {
  const now = Date.now();
  const windowStart = new Date(Math.floor(now / windowMs) * windowMs);
  const count = await prisma.$transaction(async (tx) => {
    const current = await tx.rateLimit.findUnique({ where: { key } });
    if (!current || current.windowStart.getTime() !== windowStart.getTime()) {
      await tx.rateLimit.upsert({ where: { key }, create: { key, windowStart, count: 1 }, update: { windowStart, count: 1 } });
      return 1;
    }
    return (await tx.rateLimit.update({ where: { key }, data: { count: { increment: 1 } } })).count;
  });
  if (count > limit) {
    const retryAfter = Math.max(1, Math.ceil((windowStart.getTime() + windowMs - now) / 1000));
    throw new ApiError(429, 'rate_limited', 'Too many requests, please slow down', undefined, {
      'Retry-After': String(retryAfter),
    });
  }
}
