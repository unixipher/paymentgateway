import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { ApiError, badRequest } from './errors';
import { logger } from './logger';

export function json(data: unknown, init: ResponseInit = {}) {
  const response = NextResponse.json(data, init);
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

export const noContent = () => new NextResponse(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });

export function errorResponse(err: unknown, req?: NextRequest) {
  if (err instanceof ApiError) {
    return json(
      { error: { code: err.code, message: err.message, ...(err.details !== undefined && { details: err.details }) } },
      { status: err.status, headers: err.headers },
    );
  }
  if (err instanceof z.ZodError) {
    return json(
      {
        error: {
          code: 'validation_failed',
          message: 'Request validation failed',
          details: err.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
        },
      },
      { status: 400 },
    );
  }
  logger.error('unhandled error', { err, method: req?.method, path: req?.nextUrl.pathname });
  return json({ error: { code: 'internal_error', message: 'Something went wrong' } }, { status: 500 });
}

type Handler<Ctx> = (req: NextRequest, ctx: Ctx) => Promise<Response>;

/** Wraps a route handler so every error becomes a consistent JSON error response. */
export function handler<Ctx = unknown>(fn: Handler<Ctx>): Handler<Ctx> {
  return async (req, ctx) => {
    try {
      return await fn(req, ctx);
    } catch (err) {
      return errorResponse(err, req);
    }
  };
}

export async function readJson<T extends z.ZodType>(req: NextRequest, schema: T): Promise<z.infer<T>> {
  let body: unknown;
  try {
    const text = await req.text();
    body = text ? JSON.parse(text) : {};
  } catch {
    throw badRequest('Request body must be valid JSON');
  }
  return schema.parse(body);
}

export function clientIp(req: NextRequest): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || 'unknown';
}

export const paginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).optional(),
});

export const searchParams = (req: NextRequest) => Object.fromEntries(req.nextUrl.searchParams);
