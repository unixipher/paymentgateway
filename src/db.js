import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

function adapter(databaseUrl) {
  if (!databaseUrl) throw new Error('Missing env var DATABASE_URL (see .env.example)');
  // `?schema=` is a Prisma convention the pg driver doesn't understand, so pass it separately.
  const url = new URL(databaseUrl);
  const schema = url.searchParams.get('schema') ?? undefined;
  url.searchParams.delete('schema');
  return new PrismaPg({ connectionString: url.toString() }, { schema });
}

export const prisma = new PrismaClient({ adapter: adapter(process.env.DATABASE_URL) });

export const isUniqueViolation = (err) => err?.code === 'P2002';
