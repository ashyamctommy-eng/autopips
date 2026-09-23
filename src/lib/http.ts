import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import type { ApiErrorCode, ApiResponse } from '@/lib/contracts';

/**
 * Uniform JSON responder. Every API route returns the same envelope so the
 * frontend has exactly one shape to parse.
 */

export class ApiError extends Error {
  constructor(
    public readonly code: ApiErrorCode,
    message: string,
    public readonly status = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static badRequest(message = 'Bad request', details?: unknown) {
    return new ApiError('BAD_REQUEST', message, 400, details);
  }
  static unauthorized(message = 'Authentication required.') {
    return new ApiError('UNAUTHORIZED', message, 401);
  }
  static forbidden(message = 'You do not have access to this resource.') {
    return new ApiError('FORBIDDEN', message, 403);
  }
  static notFound(message = 'Not found.') {
    return new ApiError('NOT_FOUND', message, 404);
  }
  static conflict(message = 'Conflict.') {
    return new ApiError('CONFLICT', message, 409);
  }
  static rateLimited(message = 'Too many requests.') {
    return new ApiError('RATE_LIMITED', message, 429);
  }
  static kycRequired(message = 'Identity verification (KYC) approval is required.') {
    return new ApiError('KYC_REQUIRED', message, 403);
  }
  static insufficientFunds(message = 'Insufficient available funds.') {
    return new ApiError('INSUFFICIENT_FUNDS', message, 400);
  }
  static riskRejected(message: string, details?: unknown) {
    return new ApiError('RISK_REJECTED', message, 422, details);
  }
  static brokerUnavailable(message = 'Broker connection is unavailable.') {
    return new ApiError('BROKER_UNAVAILABLE', message, 503);
  }
  static paymentError(message = 'Payment provider error.') {
    return new ApiError('PAYMENT_ERROR', message, 502);
  }
  static internal(message = 'Internal server error.') {
    return new ApiError('INTERNAL', message, 500);
  }
}

export function ok<T>(data: T, init?: { status?: number; disclaimer?: string }) {
  const body: ApiResponse<T> = { ok: true, data };
  if (init?.disclaimer) body.disclaimer = init.disclaimer;
  return NextResponse.json(body, { status: init?.status ?? 200 });
}

export function fail(error: ApiError) {
  const body: ApiResponse<never> = {
    ok: false,
    error: { code: error.code, message: error.message, details: error.details },
  };
  return NextResponse.json(body, { status: error.status });
}

/**
 * Wrap a route handler: converts thrown ApiError/ZodError/unknown into the
 * standard envelope, and never leaks a stack trace to the caller.
 */
export function handler<Args extends unknown[]>(
  fn: (...args: Args) => Promise<Response>,
) {
  return async (...args: Args): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (err) {
      if (err instanceof ApiError) return fail(err);
      if (err instanceof ZodError) {
        return fail(
          new ApiError(
            'VALIDATION_FAILED',
            'Request validation failed.',
            422,
            err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          ),
        );
      }
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error('[api] unhandled error:', message, err);
      return fail(ApiError.internal());
    }
  };
}

/** Parse a JSON body and turn malformed JSON into a 400 rather than a 500. */
export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw ApiError.badRequest('Request body must be valid JSON.');
  }
}

/** Best-effort client IP for audit logging behind a proxy/CDN. */
export function clientIp(request: Request): string | null {
  const h = request.headers;
  const forwarded = h.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();
  return h.get('x-real-ip') ?? h.get('cf-connecting-ip') ?? null;
}
