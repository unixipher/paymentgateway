import { defineConfig } from 'prisma/config';

// The Prisma CLI doesn't read .env by itself. Variables already set in the environment win.
try {
  process.loadEnvFile();
} catch {
  // no .env file (e.g. on Vercel, where variables come from the project settings)
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.DATABASE_URL ?? '' },
});
