import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

import { ApiError } from '@/lib/http';

/**
 * DERIV WEBSOCKET TRANSPORT.
 *
 * A thin, typed, own-the-errors client over `wss://ws.derivws.com/websockets/v3`.
 * It deliberately does NOT use `@deriv/deriv-api`: that package ships no
 * TypeScript types at all, and on a path that submits trade orders we want the
 * request/response shapes and the error surface to be explicit and reviewable
 * rather than inferred from an untyped wrapper.
 *
 * Responsibilities kept here (and nowhere else):
 *   • one socket, one request/response correlation table keyed by `req_id`
 *     (Deriv echoes the id it was given, and every response is either a payload
 *     or an `error` object — both routed by that id);
 *   • subscriptions routed by `subscription.id` (the id Deriv issues on the
 *     first message of a stream) with the subscribing `req_id` as the fallback
 *     until that id arrives;
 *   • `forget` on unsubscribe, and no leaked timers: every request carries a
 *     timeout so a silent socket can never wedge a caller;
 *   • Deriv error codes translated into this platform's `ApiError` envelope,
 *     with the broker's own wording preserved (an operator reading
 *     "InvalidToken" should see exactly that).
 *
 * What it does NOT do: reconnect, resubscribe, authenticate, or decide which
 * symbols matter. Those are broker-policy decisions and live in the adapter.
 */

/** Deriv's own default; the app_id is appended as a query parameter. */
// Endpoint constants live in a dependency-free leaf module: `env.ts` needs them
// for its defaults and its retired-host guard, and env.ts must not import `ws`
// indirectly (that cycle once made every default evaluate to undefined).
import {
  DERIV_PUBLIC_WS_URL,
  DERIV_REST_BASE_URL,
  DERIV_RETIRED_HOSTS,
  isRetiredDerivHost,
} from './deriv.endpoints';

export { DERIV_PUBLIC_WS_URL, DERIV_REST_BASE_URL, DERIV_RETIRED_HOSTS, isRetiredDerivHost };

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

/** @deprecated Use {@link DERIV_PUBLIC_WS_URL}; the old host is retired. */
export const DERIV_DEFAULT_URL = DERIV_PUBLIC_WS_URL;

export interface DerivErrorPayload {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

interface PendingRequest {
  label: string;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
}

interface ActiveSubscription {
  /** Deriv's subscription id, once the first message has delivered it. */
  subscriptionId: string | null;
  label: string;
  onMessage: (message: Record<string, unknown>) => void;
  onError?: (error: DerivErrorPayload) => void;
}

export interface DerivSubscribeResult {
  /** Deriv's subscription id — pass this to `forget()`. Null when absent. */
  subscriptionId: string | null;
  /** The first message of the stream (already validated as an object). */
  first: Record<string, unknown>;
}

export interface DerivClientOptions {
  appId: string;
  url?: string;
  requestTimeoutMs?: number;
  connectTimeoutMs?: number;
  /** Called once per socket close. Reconnection policy belongs to the caller. */
  onClose?: (reason: string) => void;
}

/** Deriv error codes that mean "the request itself was wrong", not "try later". */
const REQUEST_ERROR_CODES = new Set([
  'InputValidationFailed',
  'InvalidSymbol',
  'SymbolNotFound',
  'WrongResponse',
  'UnsupportedContractType',
  'ContractCreationFailure',
  'InsufficientBalance',
  'InvalidArgument',
]);

function toApiError(payload: DerivErrorPayload, label: string): ApiError {
  const detail = `${payload.code}: ${payload.message}`;
  if (REQUEST_ERROR_CODES.has(payload.code)) {
    return ApiError.badRequest(`Deriv rejected ${label} — ${detail}`, payload.details);
  }
  return ApiError.brokerUnavailable(`Deriv could not serve ${label} — ${detail}`);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export class DerivClient {
  private readonly options: Required<Omit<DerivClientOptions, 'onClose'>> & {
    onClose?: (reason: string) => void;
  };

  private socket: WebSocket | null = null;
  private nextReqId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  /** Subscriptions whose id Deriv has not told us yet, keyed by req_id. */
  private readonly subscribing = new Map<number, ActiveSubscription>();
  /** Established subscriptions, keyed by Deriv's subscription id. */
  private readonly subscriptions = new Map<string, ActiveSubscription>();
  private closeNotified = false;

  constructor(options: DerivClientOptions) {
    this.options = {
      appId: options.appId,
      url: (options.url ?? DERIV_DEFAULT_URL).replace(/\/+$/, ''),
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      connectTimeoutMs: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      onClose: options.onClose,
    };
  }

  isConnected(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  /** Deriv's subscription ids currently held (observability + tests). */
  activeSubscriptionIds(): string[] {
    return Array.from(this.subscriptions.keys()).sort();
  }

  /** Connect if needed. Safe to call concurrently: one socket is created. */
  async connect(): Promise<void> {
    if (this.isConnected()) return;

    const url = `${this.options.url}?app_id=${encodeURIComponent(this.options.appId)}`;
    const socket = new WebSocket(url);
    this.socket = socket;
    this.closeNotified = false;

    socket.on('message', (data: WebSocket.RawData) => this.handleMessage(data.toString()));
    socket.on('error', (err: Error) => this.failAll(`socket error: ${err.message}`));
    socket.on('close', (code: number, reason: Buffer) => this.handleClose(code, reason.toString()));

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(ApiError.brokerUnavailable('Timed out opening the Deriv WebSocket.'));
        try {
          socket.terminate();
        } catch {
          // already gone
        }
      }, this.options.connectTimeoutMs);

      const onOpen = () => {
        clearTimeout(timer);
        socket.off('error', onError);
        resolve();
      };
      const onError = (err: Error) => {
        clearTimeout(timer);
        socket.off('open', onOpen);
        reject(ApiError.brokerUnavailable(`Could not reach Deriv: ${err.message}`));
      };

      socket.once('open', onOpen);
      socket.once('error', onError);
    });
  }

  /** One request/response round trip. Throws ApiError on a Deriv error object. */
  async request<T = Record<string, unknown>>(
    payload: Record<string, unknown>,
    label: string,
    timeoutMs = this.options.requestTimeoutMs,
  ): Promise<T> {
    await this.connect();
    const socket = this.socket;
    if (!socket) throw ApiError.brokerUnavailable('Deriv socket is not open.');

    const reqId = this.nextReqId++;

    const response = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(ApiError.brokerUnavailable(`Deriv did not answer ${label} within ${timeoutMs}ms.`));
      }, timeoutMs);

      this.pending.set(reqId, { label, resolve, reject, timer });
      socket.send(JSON.stringify({ ...payload, req_id: reqId }), (err?: Error) => {
        if (!err) return;
        this.settle(reqId, null, err);
      });
    });

    const record = asRecord(response);
    if (!record) {
      throw ApiError.brokerUnavailable(`Deriv answered ${label} with an unexpected payload.`);
    }
    return record as T;
  }

  /**
   * Open a stream. Resolves with Deriv's subscription id plus the first message;
   * every later message goes to `onMessage` until `forget()` (or the socket
   * closes, which drops the subscription broker-side).
   */
  async subscribe(
    payload: Record<string, unknown>,
    label: string,
    onMessage: (message: Record<string, unknown>) => void,
    onError?: (error: DerivErrorPayload) => void,
    timeoutMs = this.options.requestTimeoutMs,
  ): Promise<DerivSubscribeResult> {
    await this.connect();
    const socket = this.socket;
    if (!socket) throw ApiError.brokerUnavailable('Deriv socket is not open.');

    const reqId = this.nextReqId++;
    const subscription: ActiveSubscription = { subscriptionId: null, label, onMessage, onError };
    this.subscribing.set(reqId, subscription);

    const first = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        this.subscribing.delete(reqId);
        reject(ApiError.brokerUnavailable(`Deriv did not confirm the ${label} subscription.`));
      }, timeoutMs);

      this.pending.set(reqId, {
        label,
        timer,
        resolve: (value) => resolve(asRecord(value) ?? {}),
        reject,
      });

      socket.send(JSON.stringify({ ...payload, subscribe: 1, req_id: reqId }), (err?: Error) => {
        if (!err) return;
        this.subscribing.delete(reqId);
        this.settle(reqId, null, err);
      });
    });

    const subscriptionId = this.subscriptionIdOf(first);
    if (subscriptionId) this.establish(subscriptionId, subscription);

    return { subscriptionId, first };
  }

  /** Stop a stream. Best-effort: a dead socket has already dropped it. */
  async forget(subscriptionId: string): Promise<void> {
    const subscription = this.subscriptions.get(subscriptionId);
    if (subscription) subscription.subscriptionId = null;
    this.subscriptions.delete(subscriptionId);

    if (!this.isConnected()) return;
    try {
      await this.request({ forget: subscriptionId }, `forget(${subscriptionId})`);
    } catch (err) {
      // The stream is gone from our side either way; a failure here is noise.
      console.warn(
        `[deriv.client] forget(${subscriptionId}) failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /** Drop every subscription (socket close already does this broker-side). */
  clearSubscriptions(): void {
    this.subscriptions.clear();
    this.subscribing.clear();
  }

  close(): void {
    const socket = this.socket;
    this.socket = null;
    this.clearSubscriptions();
    this.failAll('client closed');
    try {
      socket?.close();
    } catch {
      // already closed
    }
  }

  /* ────────────────────────────── internals ─────────────────────────────── */

  private subscriptionIdOf(message: Record<string, unknown>): string | null {
    const subscription = asRecord(message.subscription);
    const id = subscription?.id;
    return typeof id === 'string' && id.length > 0 ? id : null;
  }

  private establish(subscriptionId: string, subscription: ActiveSubscription): void {
    subscription.subscriptionId = subscriptionId;
    this.subscriptions.set(subscriptionId, subscription);
  }

  private settle(reqId: number, value: unknown, error?: unknown): void {
    const pending = this.pending.get(reqId);
    if (!pending) return;
    this.pending.delete(reqId);
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve(value);
  }

  private handleMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn('[deriv.client] dropped a non-JSON frame from Deriv.');
      return;
    }

    const message = asRecord(parsed);
    if (!message) return;

    const reqId = typeof message.req_id === 'number' ? message.req_id : null;
    const subscriptionId = this.subscriptionIdOf(message);

    if (message.error) {
      const error = asRecord(message.error);
      const payload: DerivErrorPayload = {
        code: typeof error?.code === 'string' ? error.code : 'Unknown',
        message: typeof error?.message === 'string' ? error.message : 'Deriv reported an error.',
        details: asRecord(error?.details) ?? undefined,
      };

      // An error can belong to a one-shot request, to a first subscription
      // response, or to an established stream (e.g. a subscription dropped).
      if (reqId !== null && this.subscribing.has(reqId) && subscriptionId === null) {
        const subscription = this.subscribing.get(reqId)!;
        this.subscribing.delete(reqId);
        subscription.onError?.(payload);
        this.settle(reqId, null, toApiError(payload, subscription.label));
        return;
      }
      if (subscriptionId && this.subscriptions.has(subscriptionId)) {
        this.subscriptions.get(subscriptionId)!.onError?.(payload);
        return;
      }
      if (reqId !== null && this.pending.has(reqId)) {
        this.settle(reqId, null, toApiError(payload, this.pending.get(reqId)!.label));
        return;
      }
      console.warn(`[deriv.client] unsolicited error frame: ${payload.code} ${payload.message}`);
      return;
    }

    // Established stream: route by Deriv's subscription id.
    if (subscriptionId && this.subscriptions.has(subscriptionId)) {
      this.subscriptions.get(subscriptionId)!.onMessage(message);
      return;
    }

    // First message of a stream: bind the id and resolve the subscribe() call.
    if (reqId !== null && this.subscribing.has(reqId)) {
      const subscription = this.subscribing.get(reqId)!;
      this.subscribing.delete(reqId);
      if (subscriptionId) this.establish(subscriptionId, subscription);
      this.settle(reqId, message);
      return;
    }

    if (reqId !== null && this.pending.has(reqId)) {
      this.settle(reqId, message);
      return;
    }

    console.warn('[deriv.client] dropped a frame that matched no request or subscription.');
  }

  private failAll(reason: string): void {
    for (const [reqId, pending] of Array.from(this.pending.entries())) {
      this.settle(reqId, null, ApiError.brokerUnavailable(`Deriv connection lost: ${reason}`));
    }
    this.subscribing.clear();
    this.subscriptions.clear();
  }

  private handleClose(code: number, reason: string): void {
    this.socket = null;
    this.failAll(`socket closed (${code}${reason ? ` ${reason}` : ''})`);
    if (this.closeNotified) return;
    this.closeNotified = true;
    this.options.onClose?.(reason || `closed with code ${code}`);
  }
}

/** Correlation key for logs/tests that need one. */
export function derivRequestId(): string {
  return randomUUID();
}
