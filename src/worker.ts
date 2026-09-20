import { setTimeout as sleep } from 'node:timers/promises';
import { prisma } from './lib/db';
import { config } from './lib/env';
import { logger } from './lib/logger';
import { runBackgroundTick } from './lib/tick';

const envFile = process.env.ENV_FILE ?? '.env.production';
try {
  process.loadEnvFile(envFile);
} catch (err) {
  if (process.env.NODE_ENV === 'production') throw new Error(`Could not load ${envFile}`, { cause: err });
  try { process.loadEnvFile('.env'); } catch { /* Local environment variables may already be set. */ }
}

const abort = new AbortController();
let stopping = false;

const { workerIntervalMs } = config();

function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info('worker stopping', { signal });
  abort.abort();
}

process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));

async function main() {
  logger.info('worker started', { interval_ms: workerIntervalMs });

  while (!stopping) {
    const cycleStartedAt = Date.now();
    try {
      await runBackgroundTick();
    } catch (err) {
      logger.error('background tick failed', { err });
    }

    const waitMs = Math.max(1_000, workerIntervalMs - (Date.now() - cycleStartedAt));
    try {
      await sleep(waitMs, undefined, { signal: abort.signal });
    } catch {
      // An aborted wait means the container is shutting down.
    }
  }

  await prisma.$disconnect();
  logger.info('worker stopped');
}

main().catch((err) => {
  logger.error('worker crashed', { err });
  process.exitCode = 1;
});
