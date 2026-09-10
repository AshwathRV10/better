/** Application error taxonomy, mapped onto HTTP status codes by the API layer. */

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'PROVIDER_ERROR'
  | 'INSUFFICIENT_DATA'
  | 'INTERNAL';

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError('BAD_REQUEST', message, 400, details);

export const unauthorized = (message = 'Missing or invalid API key') =>
  new AppError('UNAUTHORIZED', message, 401);

export const notFound = (message: string) => new AppError('NOT_FOUND', message, 404);

export const rateLimited = (retryAfterSeconds: number) =>
  new AppError('RATE_LIMITED', 'Too many requests', 429, { retryAfterSeconds });

/**
 * Raised when a prediction cannot be produced because the required data is
 * missing. The API returns this rather than a fabricated prediction.
 */
export const insufficientData = (message: string, details?: unknown) =>
  new AppError('INSUFFICIENT_DATA', message, 422, details);

export const internal = (message = 'Internal server error') =>
  new AppError('INTERNAL', message, 500);
