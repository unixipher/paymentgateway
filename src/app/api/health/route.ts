import { prisma } from '@/lib/db';
import { json } from '@/lib/http';
import { logger } from '@/lib/logger';

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return json({ status: 'ok', database: 'up' });
  } catch (err) {
    logger.error('health check failed', { err });
    return json({ status: 'degraded', database: 'down' }, { status: 503 });
  }
}
