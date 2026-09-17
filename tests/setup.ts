try {
  process.loadEnvFile();
} catch {
  // no .env
}

export const hasDatabase = Boolean(process.env.DATABASE_URL);

if (process.env.DATABASE_URL) {
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set('schema', 'gateway_test');
  process.env.DATABASE_URL = url.toString();
} else {
  process.env.DATABASE_URL = 'postgres://unused@localhost/unused';
}

// Fixed test values, independent of the real .env secrets.
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.GOOGLE_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.FRONTEND_URL = 'https://dashboard.example.com';
process.env.API_BASE_URL = 'https://api.example.com';
process.env.CRON_SECRET = 'test-cron-secret-0123456789';
delete process.env.CORS_ORIGINS;
