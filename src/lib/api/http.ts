/**
 * API plumbing: consistent response envelopes, validation, authentication and
 * rate limiting for every route under /api.
 */

import { NextResponse } from 'next/server';
import { ZodError, type TypeOf, type ZodTypeAny } from 'zod';
import { AppError, badRequest, internal, rateLimited, unauthorized } from '../errors';
import { getConfig } from '../config';
import { ProviderError } from '../providers/types';

export interface ApiMeta {
  readonly generatedAt: string;
  readonly [key: string]: unknown;
}

export function ok<T>(data: T, meta: Partial<ApiMeta> = {}, init: ResponseInit = {}): NextResponse {
  return NextResponse.json(
    { data, meta: { generatedAt: new Date().toISOString(), ...meta } },
    init,
  );
}

export interface ApiErrorBody {
  readonly error: { readonly code: string; readonly message: string; readonly details?: unknown };
}

/**
 * Converts any thrown value into a safe response.
 *
 * Internal errors never leak their message to the client: an unexpected
 * exception could contain a connection string or a query fragment. Known
 * `AppError`s carry messages that were written to be shown.
 */
export function toErrorResponse(error: unknown): NextResponse {
  if (error instanceof ZodError) {
    const details = error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
    return NextResponse.json(
      { error: { code: 'BAD_REQUEST', message: 'Invalid request parameters', details } },
      { status: 400 },
    );
  }

  if (error instanceof AppError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message, details: error.details } },
      {
        status: error.status,
        headers:
          error.code === 'RATE_LIMITED'
            ? { 'Retry-After': String((error.details as { retryAfterSeconds: number }).retryAfterSeconds) }
            : undefined,
      },
    );
  }

  if (error instanceof ProviderError) {
    return NextResponse.json(
      { error: { code: 'PROVIDER_ERROR', message: error.message } },
      { status: error.retryable ? 503 : 502 },
    );
  }

  console.error('Unhandled API error:', error);
  const fallback = internal();
  return NextResponse.json(
    { error: { code: fallback.code, message: fallback.message } },
    { status: fallback.status },
  );
}

/** Parses and validates query parameters, throwing a ZodError on failure. */
export function parseQuery<S extends ZodTypeAny>(request: Request, schema: S): TypeOf<S> {
  const params = new URL(request.url).searchParams;
  const raw: Record<string, string | string[]> = {};
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    raw[key] = values.length > 1 ? values : values[0];
  }
  return schema.parse(raw);
}

export async function parseBody<S extends ZodTypeAny>(request: Request, schema: S): Promise<TypeOf<S>> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    throw badRequest('Request body must be valid JSON');
  }
  return schema.parse(payload);
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Fixed-window rate limiter held in process memory.
 *
 * Adequate for a single instance. A multi-instance deployment needs a shared
 * store (Redis) - this is called out in the README rather than pretended away.
 */
const buckets = new Map<string, Bucket>();

/** Prevents the map from growing without bound under many distinct clients. */
const MAX_TRACKED_CLIENTS = 10_000;

export function clientKey(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return request.headers.get('x-real-ip') ?? 'anonymous';
}

export function enforceRateLimit(request: Request): void {
  const config = getConfig();
  const key = clientKey(request);
  const now = Date.now();

  if (buckets.size > MAX_TRACKED_CLIENTS) {
    for (const [existing, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(existing);
    }
  }

  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + config.RATE_LIMIT_WINDOW_MS });
    return;
  }

  bucket.count += 1;
  if (bucket.count > config.RATE_LIMIT_MAX) {
    throw rateLimited(Math.ceil((bucket.resetAt - now) / 1000));
  }
}

/** Test hook: clears the limiter between test cases. */
export function resetRateLimiter(): void {
  buckets.clear();
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/**
 * Requires the shared secret on mutating routes.
 *
 * When API_ACCESS_KEY is unset the check is skipped, which keeps local
 * development frictionless; the README states that it must be set in any
 * deployment. Comparison is length-safe and constant-time to avoid leaking the
 * key through timing.
 */
export function requireApiKey(request: Request): void {
  const expected = getConfig().API_ACCESS_KEY;
  if (expected.length === 0) return;

  const provided = request.headers.get('x-api-key') ?? '';
  if (!timingSafeEqual(provided, expected)) throw unauthorized();
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

/** Wraps a route handler with rate limiting and error translation. */
export function route(
  handler: (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<NextResponse>,
) {
  return async (
    request: Request,
    context: { params: Promise<Record<string, string>> },
  ): Promise<NextResponse> => {
    try {
      enforceRateLimit(request);
      return await handler(request, context);
    } catch (error) {
      return toErrorResponse(error);
    }
  };
}
