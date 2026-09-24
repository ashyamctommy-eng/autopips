'use client';

/**
 * `useTradingSocket` — the single React binding for the trading realtime feed.
 *
 * Connects to the `/ws/trading` namespace, joins one investment room, and
 * mirrors the incoming events into typed React state:
 *
 *   trade:opened|updated|closed -> positionUpdates (live deltas, by position id)
 *                                 + positions (full PositionDTO snapshots)
 *   price:tick                  -> ticks (by symbol)
 *   bot:activity                -> activity (newest first, de-duplicated, capped)
 *   account:equity              -> equity (AccountOverview) or investmentEquity
 *   broker:status               -> brokerStatus
 *   server:error                -> serverError
 *
 * The socket carries *deltas*: the broker bridge publishes only the fields it
 * observed (`broker.registry.ts`), so a widget hydrates once from REST
 * (`PositionDTO`) and folds deltas on with `livePosition()` / `
 * applyPositionUpdate()`. Nothing is ever zero-filled to fill a gap.
 *
 * The hook owns cleanup: listeners are removed, rooms are left and the socket
 * is disconnected on unmount. Dependencies are React + socket.io-client only.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { WS_EVENTS, marketRoom, normaliseMarketSymbol } from '@/lib/contracts';
import {
  applyPositionUpdate,
  createTradingSocket,
  fetchSocketToken,
  isAccountOverview,
  isActivityEventDTO,
  isAuthFailure,
  isBrokerStatusPayload,
  isInvestmentEquityUpdate,
  isPositionDTO,
  isPositionUpdate,
  isPriceTick,
  isServerErrorMessage,
  positionKey,
  type BrokerStatusPayload,
  type InvestmentEquityUpdate,
  type PositionUpdate,
  type PriceTick,
  type ServerErrorMessage,
  type TradingSocket,
} from '@/lib/socket-client';
import type { AccountOverview, ActivityEventDTO, PositionDTO } from '@/types/api';

export type TradingSocketStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';

export interface UseTradingSocketOptions {
  /** Investment room to mirror. Change it and the hook re-subscribes. */
  investmentId?: string | null;
  /**
   * Instrument whose live quotes this hook should demand from the broker
   * terminal. Joining `market:<SYMBOL>` is what starts the upstream MetaApi
   * subscription; leaving it (or disconnecting) releases it. Ticks themselves
   * arrive on the namespace-wide `price:tick` event, filtered here by symbol.
   */
  marketSymbol?: string | null;
  /** Set false to keep the hook mounted without a connection (e.g. preview mode). */
  enabled?: boolean;
  /** Activity feed cap. Defaults to 100 entries. */
  activityLimit?: number;
  onActivity?: (event: ActivityEventDTO) => void;
  onPositionUpdate?: (update: PositionUpdate) => void;
  onEquity?: (overview: AccountOverview) => void;
  onBrokerStatus?: (status: BrokerStatusPayload) => void;
  onServerError?: (error: ServerErrorMessage) => void;
}

export interface UseTradingSocketResult {
  socket: TradingSocket | null;
  status: TradingSocketStatus;
  /** True only while the socket is actually connected. */
  connected: boolean;
  /** Last connection error, cleared on a successful (re)connect. */
  error: string | null;
  /**
   * Full position snapshots keyed by position id — populated when a publisher
   * sends a complete `PositionDTO` (e.g. an API route re-broadcasting a REST
   * snapshot). The broker bridge sends deltas; see `positionUpdates`.
   */
  positions: Record<string, PositionDTO>;
  /** Live deltas from `trade:opened|updated|closed`, keyed by position id. */
  positionUpdates: Record<string, PositionUpdate>;
  /**
   * The live view of an open position: the hydrate-once DTO with the latest
   * delta folded in. Null until the snapshot arrives.
   */
  livePosition: (positionId: string) => PositionDTO | null;
  /** Open positions from the snapshot map, newest first. */
  openPositions: PositionDTO[];
  /** Latest tick per symbol. */
  ticks: Record<string, PriceTick>;
  /** Activity feed, newest first. */
  activity: ActivityEventDTO[];
  /** Account-scoped overview (`account:equity`). */
  equity: AccountOverview | null;
  /** Investment-scoped live roll-ups, keyed by investmentId. */
  investmentEquity: Record<string, InvestmentEquityUpdate>;
  brokerStatus: BrokerStatusPayload | null;
  serverError: ServerErrorMessage | null;
  /** Rooms the hook believes it is in (`trading:<investmentId>`). */
  joinedRooms: string[];
  subscribe: (investmentId: string) => void;
  unsubscribe: (investmentId: string) => void;
  clearActivity: () => void;
  reconnect: () => void;
}

const DEFAULT_ACTIVITY_LIMIT = 100;

function roomFor(investmentId: string): string {
  return `trading:${investmentId}`;
}

/**
 * `trade:opened` / `trade:updated` mean the position is open, `trade:closed`
 * means it is closed. The bridge usually omits `status`, so the lifecycle is
 * taken from the event name — unless the payload states it explicitly.
 */
function withLifecycleStatus(
  payload: PositionUpdate,
  status: 'OPEN' | 'CLOSED',
): PositionUpdate {
  return typeof payload.status === 'string' && payload.status.length > 0
    ? payload
    : { ...payload, status };
}

export function useTradingSocket(options: UseTradingSocketOptions = {}): UseTradingSocketResult {
  const {
    investmentId = null,
    marketSymbol = null,
    enabled = true,
    activityLimit = DEFAULT_ACTIVITY_LIMIT,
  } = options;

  const [socket, setSocket] = useState<TradingSocket | null>(null);
  const [status, setStatus] = useState<TradingSocketStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [positions, setPositions] = useState<Record<string, PositionDTO>>({});
  const [positionUpdates, setPositionUpdates] = useState<Record<string, PositionUpdate>>({});
  const [ticks, setTicks] = useState<Record<string, PriceTick>>({});
  const [activity, setActivity] = useState<ActivityEventDTO[]>([]);
  const [equity, setEquity] = useState<AccountOverview | null>(null);
  const [investmentEquity, setInvestmentEquity] = useState<
    Record<string, InvestmentEquityUpdate>
  >({});
  const [brokerStatus, setBrokerStatus] = useState<BrokerStatusPayload | null>(null);
  const [serverError, setServerError] = useState<ServerErrorMessage | null>(null);
  const [joinedRooms, setJoinedRooms] = useState<string[]>([]);

  const socketRef = useRef<TradingSocket | null>(null);
  /** Latest callbacks without re-creating the connection. */
  const optionsRef = useRef(options);
  /** Guards the socket-token fallback so it runs at most once per connection. */
  const tokenAttemptedRef = useRef(false);

  useEffect(() => {
    optionsRef.current = options;
  });

  /**
   * A full `PositionDTO` replaces the snapshot; a partial broker delta is
   * folded in so a later partial event can never erase known values.
   */
  const upsertPosition = useCallback((update: PositionUpdate) => {
    const key = positionKey(update);
    if (!key) return;
    setPositionUpdates((prev) => {
      const merged: PositionUpdate = { ...prev[key] };
      for (const [field, value] of Object.entries(update)) {
        if (value !== undefined && value !== null) {
          (merged as Record<string, unknown>)[field] = value;
        }
      }
      return { ...prev, [key]: merged };
    });
    if (isPositionDTO(update)) {
      const dto = update;
      setPositions((prev) => ({ ...prev, [positionKey(dto) ?? dto.id]: dto }));
    }
    optionsRef.current.onPositionUpdate?.(update);
  }, []);

  const pushActivity = useCallback(
    (event: ActivityEventDTO) => {
      setActivity((prev) => {
        // The bus may target several rooms at once, so the same activity can
        // arrive twice; de-duplicate on the event id.
        if (prev.some((entry) => entry.id === event.id)) return prev;
        return [event, ...prev].slice(0, activityLimit);
      });
      optionsRef.current.onActivity?.(event);
    },
    [activityLimit],
  );

  /* ───────────────────────── connect / teardown ───────────────────────── */

  useEffect(() => {
    if (!enabled) {
      setStatus('idle');
      return;
    }

    const next = createTradingSocket();
    if (!next) return; // SSR: no socket on the server.
    socketRef.current = next;
    tokenAttemptedRef.current = false;
    setSocket(next);
    setStatus('connecting');

    const handleConnect = () => {
      tokenAttemptedRef.current = false;
      setStatus('connected');
      setError(null);
    };

    const handleDisconnect = () => {
      setStatus('reconnecting');
      setJoinedRooms([]);
    };

    const handleConnectError = (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      // The server reads the httpOnly cookie from the handshake by default.
      // If that failed (cross-site deployment, cookie blocked), fall back to a
      // short-lived socket token — fetched once, held in memory only.
      if (isAuthFailure(err) && !tokenAttemptedRef.current) {
        tokenAttemptedRef.current = true;
        void fetchSocketToken().then((token) => {
          if (!token) {
            setStatus('error');
            return;
          }
          next.connect();
        });
        return;
      }
      // socket.io keeps retrying on its own; surface it as reconnecting.
      setStatus(next.active ? 'reconnecting' : 'error');
    };

    const handleOpened = (payload: unknown) => {
      if (isPositionUpdate(payload)) upsertPosition(withLifecycleStatus(payload, 'OPEN'));
    };

    const handleUpdated = (payload: unknown) => {
      if (isPositionUpdate(payload)) upsertPosition(withLifecycleStatus(payload, 'OPEN'));
    };

    const handleClosed = (payload: unknown) => {
      if (isPositionUpdate(payload)) upsertPosition(withLifecycleStatus(payload, 'CLOSED'));
    };

    const handleTick = (payload: unknown) => {
      if (!isPriceTick(payload)) return;
      setTicks((prev) => ({ ...prev, [payload.symbol]: payload }));
    };

    const handleActivity = (payload: unknown) => {
      if (isActivityEventDTO(payload)) pushActivity(payload);
    };

    const handleEquity = (payload: unknown) => {
      if (isAccountOverview(payload)) {
        setEquity(payload);
        optionsRef.current.onEquity?.(payload);
        return;
      }
      // The broker sync publishes an investment-scoped roll-up instead.
      if (isInvestmentEquityUpdate(payload)) {
        setInvestmentEquity((prev) => ({ ...prev, [payload.investmentId]: payload }));
      }
    };

    const handleBrokerStatus = (payload: unknown) => {
      if (!isBrokerStatusPayload(payload)) return;
      setBrokerStatus(payload);
      optionsRef.current.onBrokerStatus?.(payload);
    };

    const handleServerError = (payload: unknown) => {
      if (!isServerErrorMessage(payload)) return;
      setServerError(payload);
      optionsRef.current.onServerError?.(payload);
    };

    next.on('connect', handleConnect);
    next.on('disconnect', handleDisconnect);
    next.on('connect_error', handleConnectError);
    next.on(WS_EVENTS.positionOpened, handleOpened);
    next.on(WS_EVENTS.positionUpdated, handleUpdated);
    next.on(WS_EVENTS.positionClosed, handleClosed);
    next.on(WS_EVENTS.tick, handleTick);
    next.on(WS_EVENTS.activity, handleActivity);
    next.on(WS_EVENTS.equity, handleEquity);
    next.on(WS_EVENTS.brokerStatus, handleBrokerStatus);
    next.on(WS_EVENTS.error, handleServerError);

    return () => {
      next.off('connect', handleConnect);
      next.off('disconnect', handleDisconnect);
      next.off('connect_error', handleConnectError);
      next.off(WS_EVENTS.positionOpened, handleOpened);
      next.off(WS_EVENTS.positionUpdated, handleUpdated);
      next.off(WS_EVENTS.positionClosed, handleClosed);
      next.off(WS_EVENTS.tick, handleTick);
      next.off(WS_EVENTS.activity, handleActivity);
      next.off(WS_EVENTS.equity, handleEquity);
      next.off(WS_EVENTS.brokerStatus, handleBrokerStatus);
      next.off(WS_EVENTS.error, handleServerError);
      next.disconnect();
      socketRef.current = null;
      setSocket(null);
      setStatus('idle');
      setJoinedRooms([]);
    };
  }, [enabled, pushActivity, upsertPosition]);

  /* ─────────────────────── investment room lifecycle ───────────────────── */

  useEffect(() => {
    const active = socket;
    if (!active || status !== 'connected' || !investmentId) return;

    const room = roomFor(investmentId);
    active.emit(WS_EVENTS.subscribe, { investmentId });
    setJoinedRooms((prev) => (prev.includes(room) ? prev : [...prev, room]));

    return () => {
      // Only un-join while still connected: emitting on a dead socket would be
      // buffered and could arrive after the re-subscribe of a later room.
      if (active.connected) active.emit(WS_EVENTS.unsubscribe, { investmentId });
      setJoinedRooms((prev) => prev.filter((entry) => entry !== room));
    };
  }, [socket, status, investmentId]);

  /* ────────────────────────── market room lifecycle ─────────────────────── */

  useEffect(() => {
    const active = socket;
    const normalised = marketSymbol ? normaliseMarketSymbol(marketSymbol) : null;
    if (!active || status !== 'connected' || !normalised) return;

    const room = marketRoom(normalised);
    active.emit(WS_EVENTS.subscribe, { room });
    setJoinedRooms((prev) => (prev.includes(room) ? prev : [...prev, room]));

    return () => {
      if (active.connected) active.emit(WS_EVENTS.unsubscribe, { room });
      setJoinedRooms((prev) => prev.filter((entry) => entry !== room));
    };
  }, [socket, status, marketSymbol]);

  /* ─────────────────────────────── actions ─────────────────────────────── */

  const subscribe = useCallback((target: string) => {
    const active = socketRef.current;
    if (!active || !target) return;
    active.emit(WS_EVENTS.subscribe, { investmentId: target });
    const room = roomFor(target);
    setJoinedRooms((prev) => (prev.includes(room) ? prev : [...prev, room]));
  }, []);

  const unsubscribe = useCallback((target: string) => {
    const active = socketRef.current;
    const room = roomFor(target);
    if (active && active.connected && target) {
      active.emit(WS_EVENTS.unsubscribe, { investmentId: target });
    }
    setJoinedRooms((prev) => prev.filter((entry) => entry !== room));
  }, []);

  const clearActivity = useCallback(() => setActivity([]), []);

  const reconnect = useCallback(() => {
    const active = socketRef.current;
    if (!active) return;
    tokenAttemptedRef.current = false;
    if (active.connected) {
      active.disconnect();
    }
    active.connect();
  }, []);

  const openPositions = useMemo(
    () =>
      Object.values(positions)
        .filter((position) => position.status === 'OPEN')
        .sort((a, b) => (a.openedAt < b.openedAt ? 1 : -1)),
    [positions],
  );

  /** Hydrated DTO + latest live delta. See `applyPositionUpdate`. */
  const livePosition = useCallback(
    (positionId: string): PositionDTO | null => {
      const dto = positions[positionId];
      if (!dto) return null;
      const update = positionUpdates[positionId];
      return update ? applyPositionUpdate(dto, update) : dto;
    },
    [positions, positionUpdates],
  );

  return {
    socket,
    status,
    connected: status === 'connected',
    error,
    positions,
    positionUpdates,
    livePosition,
    openPositions,
    ticks,
    activity,
    equity,
    investmentEquity,
    brokerStatus,
    serverError,
    joinedRooms,
    subscribe,
    unsubscribe,
    clearActivity,
    reconnect,
  };
}

export default useTradingSocket;
