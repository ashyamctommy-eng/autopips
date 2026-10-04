import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AdminTelemetryEvent } from '@workspace/api-zod';
import { logger } from '../../../../lib/logger';
import { telemetryRedis, telemetryRedisSub } from '@/lib/redis';

export const TELEMETRY_CHANNEL = 'telemetry:events';
export const TELEMETRY_LATEST_EVENT_KEY = 'telemetry:latest';
export const TELEMETRY_LATEST_CYCLE_KEY = 'telemetry:latest:cycle';
export const TELEMETRY_LATEST_EXECUTION_KEY = 'telemetry:latest:execution';
const TELEMETRY_EVENT_TTL_SECONDS = 300;

const cycleEventSchema = z.object({
  type: z.literal('cycle'),
  eventId: z.string().min(1),
  timestamp: z.coerce.date(),
  cycleCount: z.number().int().nonnegative(),
  cycleDurationMs: z.number().int().nonnegative(),
  intervalSeconds: z.number().int().positive(),
  enabledStrategies: z.array(z.string()),
  activePlanCount: z.number().int().nonnegative().nullable(),
  tradesExecuted: z.number().int().nonnegative(),
  winRatePct: z.number().finite().nullable(),
  latestExecutionLatencyMs: z.number().finite().nonnegative().nullable(),
});

const executionEventSchema = z.object({
  type: z.literal('execution'),
  eventId: z.string().min(1),
  timestamp: z.coerce.date(),
  strategyId: z.string().min(1),
  status: z.enum(['FILLED', 'REJECTED', 'ERROR']),
  latencyMs: z.number().int().nonnegative().nullable(),
  symbol: z.string(),
  direction: z.string(),
});

const telemetryEventSchema = z.discriminatedUnion('type', [
  cycleEventSchema,
  executionEventSchema,
]);

const listeners = new Set<(event: AdminTelemetryEvent) => void>();
let subscriberStarted = false;

function decodeTelemetryEvent(raw: string): AdminTelemetryEvent | null {
  try {
    const parsedJson: unknown = JSON.parse(raw);
    const parsed = telemetryEventSchema.safeParse(parsedJson);
    return parsed.success ? (parsed.data as AdminTelemetryEvent) : null;
  } catch {
    return null;
  }
}

telemetryRedisSub.on('message', (channel, raw) => {
  if (channel !== TELEMETRY_CHANNEL) return;
  const event = decodeTelemetryEvent(raw);
  if (!event) {
    logger.warn({ channel }, 'Discarding malformed telemetry event');
    return;
  }

  for (const listener of listeners) {
    try {
      listener(event);
    } catch (err) {
      logger.error({ err }, 'Telemetry event listener failed');
    }
  }
});

/**
 * A dedicated Pub/Sub connection lets the API consume telemetry without
 * replacing subscriptions used for trading, sessions, or socket broadcasts.
 */
export async function startTelemetrySubscriber(): Promise<void> {
  if (subscriberStarted) return;
  subscriberStarted = true;
  try {
    await telemetryRedisSub.subscribe(TELEMETRY_CHANNEL);
    logger.info({ channel: TELEMETRY_CHANNEL }, 'Telemetry subscriber started');
  } catch (err) {
    subscriberStarted = false;
    logger.warn({ err, channel: TELEMETRY_CHANNEL }, 'Telemetry subscriber could not start');
  }
}

export function subscribeToTelemetryEvents(listener: (event: AdminTelemetryEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Publish one validated event and retain short-lived snapshots for API restarts. */
export async function publishTelemetryEvent(event: AdminTelemetryEvent): Promise<void> {
  const parsed = telemetryEventSchema.parse(event);
  const payload = JSON.stringify(parsed);
  const latestByTypeKey =
    parsed.type === 'cycle'
      ? TELEMETRY_LATEST_CYCLE_KEY
      : TELEMETRY_LATEST_EXECUTION_KEY;

  await Promise.all([
    telemetryRedis.set(TELEMETRY_LATEST_EVENT_KEY, payload, 'EX', TELEMETRY_EVENT_TTL_SECONDS),
    telemetryRedis.set(latestByTypeKey, payload, 'EX', TELEMETRY_EVENT_TTL_SECONDS),
    telemetryRedis.publish(TELEMETRY_CHANNEL, payload),
  ]);
}

/** Read a recent event for SSE clients connecting after the worker has started. */
export async function readLatestTelemetryEvent(
  type: 'cycle' | 'execution',
): Promise<AdminTelemetryEvent | null> {
  const key =
    type === 'cycle' ? TELEMETRY_LATEST_CYCLE_KEY : TELEMETRY_LATEST_EXECUTION_KEY;
  const raw = await telemetryRedis.get(key);
  return raw ? decodeTelemetryEvent(raw) : null;
}

export function createTelemetryEventId(): string {
  return randomUUID();
}