import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient } from '@/generated/prisma/client';
import { config } from './env';

export { Prisma } from '@/generated/prisma/client';

function createClient() {
  return new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: config().databaseUrl }) });
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
