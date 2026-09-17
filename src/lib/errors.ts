export type ErrorCode =
  | 'bad_request'
  | 'validation_failed'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'gone'
  | 'payment_failed'
  | 'rate_limited'
  | 'gmail_not_connected'
  | 'merchant_not_configured'
  | 'internal_error';

/** An error that is safe to show to API clients. Anything else becomes a generic 500. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new ApiError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Missing or invalid credentials') => new ApiError(401, 'unauthorized', message);
export const forbidden = (message: string) => new ApiError(403, 'forbidden', message);
export const notFound = (message = 'Not found') => new ApiError(404, 'not_found', message);
export const conflict = (message: string) => new ApiError(409, 'conflict', message);
