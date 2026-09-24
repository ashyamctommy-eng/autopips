import type { ApiEnvelope, ApiErrorEnvelope } from '@/types/api';

/**
 * Thin client for the `/api/v1/admin/**` routes.
 *
 * Every admin widget talks to the API through this module so there is one place
 * that:
 *   - parses the standard `{ ok, data }` / `{ ok: false, error }` envelope,
 *   - turns a Zod failure (`VALIDATION_FAILED` with `details: [{ path, message }]`)
 *     into per-field messages the forms can render next to the offending input,
 *   - carries the server's error message (e.g. the last-ADMIN refusal) through
 *     verbatim instead of inventing a friendlier one.
 *
 * It never touches localStorage and never logs a request body — admin request
 * bodies can carry a broker API token.
 */

export interface AdminApiErrorInit {
  code: string;
  status: number;
  details?: unknown;
}

export class AdminApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;
  /** `{ fieldName: message }` derived from a Zod issue list; `form` for the rest. */
  readonly fieldErrors: Record<string, string>;

  constructor(message: string, init: AdminApiErrorInit) {
    super(message);
    this.name = 'AdminApiError';
    this.code = init.code;
    this.status = init.status;
    this.details = init.details ?? null;
    this.fieldErrors = parseFieldErrors(init.details);
  }
}

/** Zod issues → `{ field: message }`. Path-less issues land on `form`. */
export function parseFieldErrors(details: unknown): Record<string, string> {
  if (!Array.isArray(details)) return {};
  const errors: Record<string, string> = {};
  for (const issue of details) {
    if (typeof issue !== 'object' || issue === null) continue;
    const record = issue as { path?: unknown; message?: unknown };
    const path = typeof record.path === 'string' ? record.path : '';
    const message = typeof record.message === 'string' ? record.message : '';
    if (!message) continue;
    const field = path.split('.')[0]?.trim() || 'form';
    if (!(field in errors)) errors[field] = message;
  }
  return errors;
}

export interface AdminRequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Serialised as JSON. Omitted entirely for bodyless requests. */
  body?: unknown;
  signal?: AbortSignal;
}

export async function adminRequest<T>(
  path: string,
  options: AdminRequestOptions = {},
): Promise<T> {
  const hasBody = options.body !== undefined;

  const response = await fetch(path, {
    method: options.method ?? 'GET',
    headers: {
      accept: 'application/json',
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
    },
    body: hasBody ? JSON.stringify(options.body) : undefined,
    cache: 'no-store',
    credentials: 'same-origin',
    signal: options.signal,
  });

  let payload: ApiEnvelope<T> | ApiErrorEnvelope | null = null;
  try {
    payload = (await response.json()) as ApiEnvelope<T> | ApiErrorEnvelope;
  } catch {
    payload = null;
  }

  if (!payload) {
    throw new AdminApiError(`The server returned an unreadable response (${response.status}).`, {
      code: 'INTERNAL',
      status: response.status,
      details: null,
    });
  }

  if (!payload.ok) {
    throw new AdminApiError(payload.error.message, {
      code: payload.error.code,
      status: response.status,
      details: payload.error.details,
    });
  }

  return payload.data;
}

/** Human-readable message for any thrown value (no stack, no secrets). */
export function errorMessage(error: unknown): string {
  if (error instanceof AdminApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Unexpected error.';
}

/** Query-string builder that drops empty values (so no `?role=` is ever sent). */
export function buildQuery(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}
