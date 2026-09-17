import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client';
import { config } from './env';

export { Prisma } from '@/generated/prisma/client';

/** Postgres schema from `?schema=` in DATABASE_URL (default `public`). */
export function dbSchema(): string {
  const schema = new URL(config().databaseUrl).searchParams.get('schema') ?? 'public';
  if (!/^[a-z_][a-z0-9_]*$/i.test(schema)) throw new Error(`Invalid schema name in DATABASE_URL: ${schema}`);
  return schema;
}

function createClient() {
  // `?schema=` is a Prisma convention the pg driver doesn't understand, so pass it separately.
  const url = new URL(config().databaseUrl);
  url.searchParams.delete('schema');
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }, { schema: dbSchema() }) });
}

// Reuse one client per process (and across hot reloads in development).
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function client(): PrismaClient {
  globalForPrisma.prisma ??= createClient();
  return globalForPrisma.prisma;
}

/** Lazily connected Prisma client, so importing this module never needs the database or env. */
export const prisma = new Proxy({} as PrismaClient, {
  get(_, property) {
    const value = Reflect.get(client(), property);
    return typeof value === 'function' ? value.bind(client()) : value;
  },
});

export const isUniqueViolation = (err: unknown) => (err as { code?: string } | null)?.code === 'P2002';
