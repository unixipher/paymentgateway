import { Prisma, dbSchema, prisma } from './db';
import { ApiError } from './errors';

/**
 * Fixed-window rate limit stored in Postgres, so it holds across serverless instances.
 * Throws a 429 with Retry-After once `limit` requests for `key` have been made in the current window.
 */
export async function rateLimit(key: string, limit: number, windowMs: number): Promise<void> {
  const now = Date.now();
  const windowStart = new Date(Math.floor(now / windowMs) * windowMs);
  // Raw SQL isn't schema-qualified by Prisma, so name the table explicitly. One atomic statement.
  const table = Prisma.raw(`"${dbSchema()}"."rate_limits"`);
  const [row] = await prisma.$queryRaw<{ count: number }[]>`
    INSERT INTO ${table} AS rl (key, window_start, count) VALUES (${key}, ${windowStart}, 1)
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN rl.window_start = EXCLUDED.window_start THEN rl.count + 1 ELSE 1 END,
      window_start = EXCLUDED.window_start
    RETURNING count`;
  if ((row?.count ?? 0) > limit) {
    const retryAfter = Math.max(1, Math.ceil((windowStart.getTime() + windowMs - now) / 1000));
    throw new ApiError(429, 'rate_limited', 'Too many requests, please slow down', undefined, {
      'Retry-After': String(retryAfter),
    });
  }
}
