import { after } from 'next/server';
import { logger } from './logger';

/**
 * Runs work after the response has been sent (kept alive by the platform via `after`).
 * Outside a request (tests, scripts) it just runs in the background.
 */
export function runAfterResponse(label: string, work: () => Promise<unknown>) {
  const run = () => work().catch((err) => logger.error(`${label} failed`, { err }));
  try {
    after(run);
  } catch {
    void run();
  }
}
