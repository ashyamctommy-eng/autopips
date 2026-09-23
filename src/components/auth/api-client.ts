/**
 * The only way the auth pages talk to the server.
 *
 * Every `/api/v1/**` route answers with the uniform envelope built by
 * `src/lib/http.ts`:
 *
 *   ok    → { ok: true,  data: <T> }
 *   error → { ok: false, error: { code, message, details? } }
 *
 * where `details` on a 422 is the list of zod issues
 * (`[{ path: 'email', message: 'Invalid email' }]`). This module parses that
 * envelope into a discriminated result so the forms never touch a raw
 * `Response`, never need `any`, and cannot accidentally read a field the API
 * does not send.
 *
 * Sessions are cookie-based (`ap_at` / refresh, httpOnly, set by the API route).
 * Nothing here reads or writes a token; `credentials: 'same-origin'` is what
 * lets the API's Set-Cookie land, and nothing is ever put in web storage.
 */

export interface FieldIssue {
  /** Dotted zod path, e.g. `email` — flattened by `handler()` in lib/http.ts. */
  path: string;
  message: string;
}

export type AuthResult<T> =
  | { kind: 'ok'; data: T }
  /** The API answered with the error envelope. `message` is the API's own copy. */
  | { kind: 'error'; statusCode: number; code: string; message: string; issues: FieldIssue[] }
  /** The request never reached the API (offline, DNS, CORS, aborted). */
  | { kind: 'network'; message: string };

const NETWORK_MESSAGE =
  'The server could not be reached. Check your connection and try again — nothing was submitted.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' ? value : null;
}

/** `details` is `unknown` on the wire; only well-formed zod issues are kept. */
function parseIssues(details: unknown): FieldIssue[] {
  if (!Array.isArray(details)) return [];
  const issues: FieldIssue[] = [];
  for (const entry of details) {
    if (!isRecord(entry)) continue;
    const path = readString(entry, 'path');
    const message = readString(entry, 'message');
    if (message) issues.push({ path: path ?? '', message });
  }
  return issues;
}

/** Per-status copy used only when the API's own message is missing. */
function fallbackMessage(statusCode: number): string {
  if (statusCode === 401) return 'Your email or password was not accepted.';
  if (statusCode === 409) return 'That request conflicts with an existing account.';
  if (statusCode === 422) return 'Some of the details you entered are not valid.';
  if (statusCode === 429) {
    return 'Too many attempts. Please wait a few minutes before trying again.';
  }
  if (statusCode >= 500) return 'The server could not complete that request. Please try again.';
  return 'That request could not be completed.';
}

export interface PostJsonOptions {
  /** Override the network-failure copy (e.g. "nothing was sent" vs "nothing changed"). */
  networkMessage?: string;
}

/**
 * POST JSON to an API route and normalise the result. Never throws.
 */
export async function postJson<T>(
  url: string,
  body: unknown,
  options: PostJsonOptions = {},
): Promise<AuthResult<T>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { kind: 'network', message: options.networkMessage ?? NETWORK_MESSAGE };
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!isRecord(payload)) {
    return {
      kind: 'error',
      statusCode: response.status,
      code: 'UNREADABLE_RESPONSE',
      message: fallbackMessage(response.status),
      issues: [],
    };
  }

  if (payload.ok === true) {
    // `data` is `T` by contract of the route being called; the envelope is the
    // only thing this module can verify.
    return { kind: 'ok', data: payload.data as T };
  }

  const error = isRecord(payload.error) ? payload.error : {};
  return {
    kind: 'error',
    statusCode: response.status,
    code: readString(error, 'code') ?? 'UNKNOWN',
    message: readString(error, 'message') ?? fallbackMessage(response.status),
    issues: parseIssues(error.details),
  };
}

/**
 * Pick the zod issues that belong to the given form fields.
 *
 * Issues for a field the form does not render (or a nested path) are dropped
 * here and surfaced by the caller as a form-level message instead, so a
 * validation problem can never be silently swallowed.
 */
export function pickFieldIssues<K extends string>(
  issues: readonly FieldIssue[],
  fields: readonly K[],
): Partial<Record<K, string>> {
  const allowed = new Set<string>(fields);
  const picked: Partial<Record<K, string>> = {};
  for (const issue of issues) {
    if (allowed.has(issue.path) && picked[issue.path as K] === undefined) {
      picked[issue.path as K] = issue.message;
    }
  }
  return picked;
}

/** True when every issue was placed on a rendered field. */
export function allIssuesMapped<K extends string>(
  issues: readonly FieldIssue[],
  picked: Partial<Record<K, string>>,
): boolean {
  return issues.every((issue) => Object.prototype.hasOwnProperty.call(picked, issue.path));
}
