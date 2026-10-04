import { Router, type IRouter, type Request, type Response } from 'express';
import {
  GetAdminTelemetryLogsQueryParams,
  GetAdminTelemetryLogsResponse,
  GetAdminTelemetrySummaryResponse,
} from '@workspace/api-zod';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import { requestContext } from '../imported/lib/request-context';
import { ApiError } from '../imported/lib/http';
import { prisma } from '../imported/lib/prisma';
import { requireSuperAdmin } from '../imported/server/modules/auth/session';
import { getTelemetryAnalyticsSnapshot } from '../imported/server/modules/telemetry/telemetry.analytics';
import {
  readLatestTelemetryEvent,
  subscribeToTelemetryEvents,
} from '../imported/server/modules/telemetry/telemetry.events';
import { getAdminTelemetrySummary } from '../imported/server/modules/telemetry/telemetry.service';
import type { AdminTelemetryEvent } from '@workspace/api-zod';

const router: IRouter = Router();

type ProtectedHandler = (req: Request, res: Response) => Promise<void>;

function sendRouteError(req: Request, res: Response, error: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (error instanceof ApiError) {
    res.status(error.status).json({
      ok: false,
      error: { code: error.code, message: error.message, details: error.details ?? null },
    });
    return;
  }
  if (error instanceof ZodError) {
    res.status(400).json({
      ok: false,
      error: { code: 'BAD_REQUEST', message: 'Invalid telemetry request.', details: error.issues },
    });
    return;
  }
  req.log.error({ err: error }, 'Super-admin telemetry request failed');
  res.status(500).json({
    ok: false,
    error: { code: 'INTERNAL', message: 'Unable to load telemetry right now.' },
  });
}

function superAdmin(handler: ProtectedHandler) {
  return async (req: Request, res: Response): Promise<void> => {
    await requestContext.run({ req, res }, async () => {
      try {
        await requireSuperAdmin();
        await handler(req, res);
      } catch (error) {
        sendRouteError(req, res, error);
      }
    });
  };
}

function queryDate(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return value;
  return new Date(value);
}

router.get(
  '/admin/telemetry/summary',
  superAdmin(async (_req, res) => {
    const data = await getAdminTelemetrySummary();
    res.json(GetAdminTelemetrySummaryResponse.parse({ ok: true, data }));
  }),
);

router.get(
  '/admin/telemetry/logs',
  superAdmin(async (req, res) => {
    const query = GetAdminTelemetryLogsQueryParams.safeParse({
      ...req.query,
      from: queryDate(req.query.from),
      to: queryDate(req.query.to),
    });
    if (!query.success) throw query.error;

    const { page, pageSize, strategy, status, from, to } = query.data;
    const searchTerm = query.data.q?.trim();
    const strategyIds =
      strategy?.trim().toLowerCase() === 'golden_momentum'
        ? ['gold-momentum', 'golden_momentum']
        : undefined;
    const where: Prisma.TradeRecordWhereInput = {
      ...(status ? { status } : {}),
      ...(strategyIds
        ? { strategyId: { in: strategyIds } }
        : strategy
          ? { strategyId: strategy.trim() }
          : {}),
      ...(from || to
        ? {
            openedAt: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {}),
            },
          }
        : {}),
      ...(searchTerm
        ? {
            OR: [
              { instrument: { contains: searchTerm, mode: 'insensitive' } },
              {
                investment: {
                  user: { email: { contains: searchTerm, mode: 'insensitive' } },
                },
              },
            ],
          }
        : {}),
    };
    const [total, rows] = await Promise.all([
      prisma.tradeRecord.count({ where }),
      prisma.tradeRecord.findMany({
        where,
        include: {
          investment: {
            select: {
              userId: true,
              user: { select: { email: true } },
              plan: { select: { name: true } },
            },
          },
        },
        orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    const data = {
      items: rows.map((row) => ({
        id: row.id,
        strategyId: row.strategyId,
        instrument: row.instrument,
        direction: row.direction,
        status: row.status,
        volume: row.volume.toString(),
        entryPrice: row.entryPrice.toString(),
        exitPrice: row.exitPrice?.toString() ?? null,
        userPnlUsd: row.netPnL.toFixed(2),
        openedAt: row.openedAt,
        closedAt: row.closedAt,
        executionRequestedAt: row.executionRequestedAt,
        executionCompletedAt: row.executionCompletedAt,
        executionLatencyMs: row.executionLatencyMs,
        userId: row.investment.userId,
        userEmail: row.investment.user.email,
        planName: row.investment.plan.name,
      })),
      page,
      pageSize,
      total,
    };
    res.json(GetAdminTelemetryLogsResponse.parse({ ok: true, data }));
  }),
);

router.get(
  '/admin/telemetry/stream',
  superAdmin(async (req, res) => {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write('retry: 5000\n: connected\n\n');

    let lastSentAt = 0;
    const sentIds = new Set<string>();
    const send = (event: AdminTelemetryEvent) => {
      const timestamp = event.timestamp instanceof Date ? event.timestamp : new Date(event.timestamp);
      const eventAt = timestamp.getTime();
      if (!Number.isFinite(eventAt) || sentIds.has(event.eventId) || eventAt < lastSentAt) return;
      lastSentAt = eventAt;
      sentIds.add(event.eventId);
      if (sentIds.size > 100) sentIds.clear();
      res.write(`id: ${event.eventId}\nevent: telemetry\ndata: ${JSON.stringify(event)}\n\n`);
    };

    const unsubscribe = subscribeToTelemetryEvents(send);
    const keepalive = setInterval(() => {
      if (!res.writableEnded) res.write(': keep-alive\n\n');
    }, 20_000);
    res.on('close', () => {
      clearInterval(keepalive);
      unsubscribe();
    });

    void Promise.all([
      readLatestTelemetryEvent('cycle'),
      readLatestTelemetryEvent('execution'),
    ])
      .then((events) => {
        events
          .filter((event): event is AdminTelemetryEvent => event !== null)
          .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
          .forEach(send);
      })
      .catch((error) => {
        req.log.warn({ err: error }, 'Could not load recent telemetry for stream replay');
      });
  }),
);

export default router;