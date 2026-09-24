'use client';

import * as React from 'react';
import { RefreshCw, Wifi } from 'lucide-react';

import {
  CandlestickChart,
  OVERLAY_COLORS,
  type ChartPriceLine,
} from '@/components/charts/candlestick-chart';
import { LiveDot, type LiveDotState } from '@/components/shared/live-dot';
import { SignedUsd, Usd } from '@/components/shared/money';
import { StatusBadge } from '@/components/shared/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { useTradingSocket, type TradingSocketStatus } from '@/hooks/use-trading-socket';
import { applyPositionUpdate, tickMid } from '@/lib/socket-client';
import { mergeTickIntoSeries } from '@/lib/candle-aggregator';
import { formatUsd } from '@/lib/money';
import { relativeTime } from '@/lib/utils';
import type { Candle } from '@/server/modules/broker/broker.types';
import type { InvestmentStatusValue, PositionDTO } from '@/types/api';

/**
 * Live trading screen (client component).
 *
 * The chart is fed by `GET /api/v1/market/candles`, which reads the broker
 * adapter directly. The server component that renders this panel has already
 * hydrated it with the client's own investments and the instruments that appear
 * in their trade records, so the selectors only ever offer instruments the
 * account has actually touched.
 *
 * When the API answers with an empty series the chart renders its own empty
 * state — this component never draws a bar the broker did not report.
 */

/** Mirrors the values the candles route accepts (the broker's timeframes). */
const TIMEFRAME_OPTIONS = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'] as const;
const CANDLE_LIMIT = 300;

export interface TradingPanelInvestment {
  id: string;
  planName: string;
  status: InvestmentStatusValue;
}

export interface TradingPanelProps {
  investments: TradingPanelInvestment[];
  /** Instruments seen in this account's positions and trade history. */
  instruments: string[];
  /** Investment whose realtime room this panel subscribes to (may be null). */
  investmentId: string | null;
  /**
   * Open positions as hydrated by the server, used for the chart's entry / stop
   * / target overlay. Live deltas from the socket are folded on top, so a moved
   * stop is drawn where the broker says it is now.
   */
  initialPositions: PositionDTO[];
}

type CandleSource = 'broker' | 'none' | 'unavailable';

interface CandlesPayload {
  symbol: string;
  timeframe: string;
  candles: Candle[];
  source: CandleSource;
}

interface CandleCandidate {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

function isCandleCandidate(value: unknown): value is CandleCandidate {
  if (typeof value !== 'object' || value === null) return false;
  const candle = value as Record<string, unknown>;
  return (
    typeof candle.time === 'number' &&
    typeof candle.open === 'number' &&
    typeof candle.high === 'number' &&
    typeof candle.low === 'number' &&
    typeof candle.close === 'number' &&
    (candle.volume === undefined || typeof candle.volume === 'number')
  );
}

/** Narrow an untrusted candle array to well-formed candles, dropping the rest. */
function toCandles(raw: unknown): Candle[] {
  if (!Array.isArray(raw)) return [];
  const candles: Candle[] = [];
  for (const item of raw) {
    if (!isCandleCandidate(item)) continue;
    const candle: Candle = {
      time: item.time,
      open: item.open,
      high: item.high,
      low: item.low,
      close: item.close,
    };
    if (typeof item.volume === 'number') candle.volume = item.volume;
    candles.push(candle);
  }
  return candles;
}

function parseCandlesEnvelope(body: unknown): CandlesPayload | null {
  if (typeof body !== 'object' || body === null) return null;
  const envelope = body as { ok?: unknown; data?: unknown };
  if (envelope.ok !== true) return null;
  const data = envelope.data as Record<string, unknown> | null | undefined;
  if (!data || typeof data !== 'object') return null;

  const symbol = typeof data.symbol === 'string' ? data.symbol : null;
  const timeframe = typeof data.timeframe === 'string' ? data.timeframe : null;
  const source =
    data.source === 'broker' || data.source === 'unavailable' || data.source === 'none'
      ? data.source
      : null;
  if (!symbol || !timeframe || !source) return null;

  return { symbol, timeframe, candles: toCandles(data.candles), source };
}

/** Server error envelope → the message the user should see. */
function errorMessage(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const envelope = body as { ok?: unknown; error?: unknown };
  if (envelope.ok !== false) return null;
  const error = envelope.error as { message?: unknown } | null | undefined;
  return typeof error?.message === 'string' ? error.message : null;
}

/** Socket connection state → the LiveDot vocabulary. */
function dotState(status: TradingSocketStatus): LiveDotState {
  switch (status) {
    case 'connected':
      return 'connected';
    case 'connecting':
      return 'connecting';
    case 'reconnecting':
      return 'paused';
    case 'error':
      return 'error';
    default:
      return 'disconnected';
  }
}

/** Prices are compared at broker precision; five decimals, no rounding loss. */
const priceFormatter = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 5,
});

export function TradingPanel({
  investments,
  instruments,
  investmentId,
  initialPositions,
}: TradingPanelProps) {
  const [roomId, setRoomId] = React.useState<string | null>(investmentId);
  const [symbol, setSymbol] = React.useState<string | null>(instruments[0] ?? null);
  const [timeframe, setTimeframe] = React.useState<string>(TIMEFRAME_OPTIONS[4]);

  const [candles, setCandles] = React.useState<Candle[]>([]);
  const [source, setSource] = React.useState<CandleSource | null>(null);
  const [isLoading, setIsLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // The connection is wanted when there is either a room to mirror (position
  // deltas, equity) or a symbol to watch (live ticks for the chart).
  const { status, brokerStatus, ticks, investmentEquity, positionUpdates } = useTradingSocket({
    investmentId: roomId,
    marketSymbol: symbol,
    enabled: Boolean(roomId || symbol),
  });

  const loadCandles = React.useCallback(
    async (signal?: AbortSignal) => {
      if (!symbol) {
        setCandles([]);
        setSource(null);
        return;
      }
      setIsLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          symbol,
          timeframe,
          limit: String(CANDLE_LIMIT),
        });
        const response = await fetch(`/api/v1/market/candles?${params.toString()}`, {
          credentials: 'include',
          cache: 'no-store',
          signal,
        });
        const body: unknown = await response.json();

        const payload = parseCandlesEnvelope(body);
        if (!payload) {
          setCandles([]);
          setSource(null);
          setError(
            errorMessage(body) ??
              `The candle request failed (HTTP ${response.status}). No chart data is available.`,
          );
          return;
        }
        setCandles(payload.candles);
        setSource(payload.source);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setCandles([]);
        setSource(null);
        setError('The candle request could not be completed. Check your connection and retry.');
      } finally {
        setIsLoading(false);
      }
    },
    [symbol, timeframe],
  );

  /* Fetch whenever the instrument or timeframe changes; abort the stale request. */
  React.useEffect(() => {
    const controller = new AbortController();
    void loadCandles(controller.signal);
    return () => controller.abort();
  }, [loadCandles]);

  const selectedInvestment = investments.find((entry) => entry.id === roomId) ?? null;
  // `account:equity` scoped to one investment — published by the broker sync,
  // never computed here. Stays absent until the sync has published it.
  const liveInvestmentEquity = roomId ? investmentEquity[roomId] : undefined;
  const brokerState = brokerStatus?.state ?? brokerStatus?.status ?? null;
  // Broker figures are in the ACCOUNT's currency, not necessarily USD — the
  // code is printed next to the number instead of a dollar sign.
  const brokerCurrency = brokerStatus?.currency ?? 'account currency';
  const tick = symbol ? ticks[symbol] : undefined;
  const mid = tick ? tickMid(tick) : null;

  /**
   * The chart's current bar, updated from streamed broker ticks between REST
   * refreshes. `mergeTickIntoSeries` returns the array unchanged when a tick
   * carries nothing usable, so a duplicate quote costs no render.
   */
  const liveCandles = React.useMemo(() => {
    if (!symbol) return candles;
    const latest = ticks[symbol];
    if (!latest) return candles;
    return mergeTickIntoSeries(candles, latest, timeframe);
  }, [candles, ticks, symbol, timeframe]);

  /**
   * Order overlay for the charted instrument: this account's open positions,
   * with live deltas applied. Only levels the broker actually reported are
   * drawn — a position without a stop has no stop line.
   */
  const chartedPositions = React.useMemo(() => {
    if (!symbol) return [];
    return initialPositions
      .filter((position) => position.status === 'OPEN' && position.instrument === symbol)
      .map((position) => {
        const update = positionUpdates[position.id];
        return update ? applyPositionUpdate(position, update) : position;
      });
  }, [initialPositions, positionUpdates, symbol]);

  const priceLines = React.useMemo<ChartPriceLine[]>(() => {
    const lines: ChartPriceLine[] = [];
    for (const position of chartedPositions) {
      lines.push({
        price: position.entryPrice,
        title: `${position.direction} ${position.volume}`,
        color: OVERLAY_COLORS.entry,
        lineStyle: 'solid',
        lineWidth: 2,
      });
      if (typeof position.stopLoss === 'number') {
        lines.push({
          price: position.stopLoss,
          title: 'Stop loss',
          color: OVERLAY_COLORS.stop,
          lineStyle: 'dashed',
        });
      }
      if (typeof position.takeProfit === 'number') {
        lines.push({
          price: position.takeProfit,
          title: 'Take profit',
          color: OVERLAY_COLORS.target,
          lineStyle: 'dashed',
        });
      }
    }
    return lines;
  }, [chartedPositions]);

  const emptyMessage =
    source === 'none'
      ? 'No broker connection is linked to this account yet, so no verified candles are available.'
      : source === 'unavailable'
        ? 'The broker connection could not serve candles for this instrument right now.'
        : 'No verified broker data for this instrument yet.';

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader className="p-5 pb-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>Live chart</CardTitle>
              <p className="mt-1 text-xs leading-relaxed text-muted">
                Candles come from the broker bridge. Symbols you have never traded are not offered,
                and an empty series is shown as such rather than filled in.
              </p>
            </div>
            <div className="flex items-center gap-2">
              {/* The bot's event channel: bot:activity, position deltas,
                  broker status and ticks all arrive on this link. The broker's
                  own state is the badge next to it. */}
              <LiveDot state={dotState(status)} />
              <span className="text-xs text-muted">Bot status</span>
              {brokerState ? (
                <StatusBadge status={brokerState} kind="broker" />
              ) : (
                <span className="text-xs text-muted">No broker event yet</span>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 p-5 pt-2">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="trading-investment">Investment room</Label>
              <Select
                value={roomId ?? undefined}
                onValueChange={(value) => setRoomId(value)}
                disabled={investments.length === 0}
              >
                <SelectTrigger id="trading-investment">
                  <SelectValue placeholder={investments.length === 0 ? 'No investment' : 'Select'} />
                </SelectTrigger>
                <SelectContent>
                  {investments.map((investment) => (
                    <SelectItem key={investment.id} value={investment.id}>
                      {investment.planName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="trading-instrument">Instrument</Label>
              <Select
                value={symbol ?? undefined}
                onValueChange={(value) => setSymbol(value)}
                disabled={instruments.length === 0}
              >
                <SelectTrigger id="trading-instrument">
                  <SelectValue
                    placeholder={instruments.length === 0 ? 'No traded instruments' : 'Select'}
                  />
                </SelectTrigger>
                <SelectContent>
                  {instruments.map((instrument) => (
                    <SelectItem key={instrument} value={instrument}>
                      {instrument}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="trading-timeframe">Timeframe</Label>
              <Select value={timeframe} onValueChange={(value) => setTimeframe(value)}>
                <SelectTrigger id="trading-timeframe">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TIMEFRAME_OPTIONS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {error ? (
            <Alert variant="warn">
              <AlertTitle>Chart data unavailable</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          <CandlestickChart
            candles={liveCandles}
            priceLines={priceLines}
            symbol={symbol ?? undefined}
            timeframe={timeframe}
            isLoading={isLoading}
            emptyMessage={emptyMessage}
            height={380}
          />

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
              {selectedInvestment ? (
                <span>
                  Room: <span className="text-base-100">{selectedInvestment.planName}</span>{' '}
                  <StatusBadge status={selectedInvestment.status} kind="investment" />
                </span>
              ) : (
                <span>No active investment room to subscribe to.</span>
              )}
              {mid !== null ? (
                <span className="inline-flex items-center gap-1.5">
                  <Wifi aria-hidden className="size-3" />
                  Live quote {priceFormatter.format(mid)}
                  {typeof tick?.bid === 'number' && typeof tick?.ask === 'number' ? (
                    <span className="text-muted/70">
                      ({priceFormatter.format(tick.bid)} / {priceFormatter.format(tick.ask)})
                    </span>
                  ) : null}
                </span>
              ) : (
                <span>No live quote received for {symbol ?? 'this instrument'} yet.</span>
              )}
            </div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => void loadCandles()}
              disabled={isLoading || !symbol}
            >
              {isLoading ? <Spinner size="sm" label="Refreshing" /> : <RefreshCw aria-hidden />}
              Refresh
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="p-5 pb-2">
          <CardTitle>Execution context</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 p-5 pt-2 text-sm">
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted">Event channel</span>
            <span className="text-base-100">{status}</span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted">Broker state</span>
            <span className="text-base-100">{brokerState ?? 'not reported yet'}</span>
          </div>
          {brokerStatus?.balance !== undefined ? (
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted">Broker balance</span>
              <span className="tabular-nums text-base-100">
                {formatUsd(brokerStatus.balance)}{' '}
                <span className="text-xs text-muted">{brokerCurrency}</span>
              </span>
            </div>
          ) : null}
          {brokerStatus?.equity !== undefined ? (
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted">Broker equity</span>
              <span className="tabular-nums text-base-100">
                {formatUsd(brokerStatus.equity)}{' '}
                <span className="text-xs text-muted">{brokerCurrency}</span>
              </span>
            </div>
          ) : null}
          {liveInvestmentEquity ? (
            <>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted">Investment value (live)</span>
                <Usd value={liveInvestmentEquity.currentValUsd} tone="neutral" />
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted">Realized P/L (live)</span>
                <SignedUsd value={liveInvestmentEquity.realizedPnL} />
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted">Unrealized P/L (live)</span>
                <SignedUsd value={liveInvestmentEquity.unrealizedPnL} />
              </div>
              <time
                dateTime={liveInvestmentEquity.at}
                suppressHydrationWarning
                className="text-xs text-muted"
              >
                Published {relativeTime(liveInvestmentEquity.at)}
              </time>
            </>
          ) : null}
          <p className="text-xs leading-relaxed text-muted">
            Figures above are only shown once the broker bridge has published them on the realtime
            channel. Absent values stay absent — they are never estimated from a chart.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

export default TradingPanel;
