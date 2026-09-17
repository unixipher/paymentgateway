import { defineConfig } from 'prisma/config';

// The Prisma CLI doesn't read .env by itself. Variables already set in the environment win.
try {
  process.loadEnvFile();
} catch {
  // no .env file
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.DATABASE_URL ?? '' },
});
