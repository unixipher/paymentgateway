import { defineConfig } from 'prisma/config';

// The Prisma CLI doesn't read .env by itself. Variables already set in the environment win.
try {
  process.loadEnvFile();
} catch {
  // no .env file (for example, when variables are supplied by the process manager)
}

export default defineConfig({
  schema: 'sqlite/schema.prisma',
  migrations: { path: 'sqlite' },
  datasource: { url: process.env.DATABASE_URL ?? 'file:./data/paymentgateway.db' },
});
