/**
 * Broker → ledger reconciliation report.
 *
 * One question: does the broker's account agree with the ledger this platform
 * keeps about it? The sync (`broker.sync.ts`) makes them agree; this module only
 * MEASURES the disagreement and reports it. It writes nothing to the ledger and
 * moves no money.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE BROKER IS COMPARED AGAINST DEPLOYED EQUITY, NOT `totalEquity`
 * ─────────────────────────────────────────────────────────────────────────────
 * A broker account only ever holds the capital that was DEPLOYED to it. The
 * platform's `getPlatformLedger().totalEquity` is a CLIENT-ACCOUNTING figure: it
 * also counts idle, unallocated cash (confirmed deposits that have not been put
 * into an investment), which by definition has not been sent to the broker. Using
 * it here would make every reconciliation report a permanent "drift" equal to the
 * idle balance — a false positive that would be ignored within a week, which is
 * worse than no alert at all.
 *
 * So the comparison figure is the ledger's DEPLOYED equity:
 *
 *     deployed = starting capital (Σ Investment.capitalUsd, ACTIVE/PAUSED)
 *              + realised P/L (Σ TradeRecord.netPnL, CLOSED)
 *              + unrealised P/L (Σ Investment.unrealizedPnL)
 *              − deducted fees (Σ Investment.feesDeducted)
 *
 * That is exactly `EQUITY_FORMULA` with the two terms that describe off-broker
 * cash movement held at zero (idle confirmed deposits, and paid withdrawals which
 * come out of idle cash). It is computed by the canonical `computeEquity` from
 * `server/accounting/ledger.ts` — this module re-implements no money arithmetic,
 * and the zeros below are deliberate inputs, not missing data.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ALERTING
 * ─────────────────────────────────────────────────────────────────────────────
 * Reading the report is read-only and writes nothing (the GET route's stance,
 * matching the AUM route). The ONLY write is a threshold breach, which records
 * `AUDIT_BROKER.BROKER_RECONCILIATION_DRIFT` and publishes an admin activity. The
 * alert is throttled (Redis, with a process-local fallback) so that a persistent
 * drift does not write one audit row per poll.
 *
 * Thresholds come from the environment, with documented defaults, rather than the
 * admin settings table: they are operator alert limits, and the settings table's
 * keys are console-editable credentials and client risk limits
 * (see settings.service.ts). Making them env-only keeps a settings write from
 * being able to silence a reconciliation alert.
 */

import type { BrokerConnection } from '@prisma/client';
import { ApiError } from '@/lib/http';
import { prisma } from '@/lib/prisma';
import { redis, rkey } from '@/lib/redis';
import { D, usd } from '@/lib/money';
import { computeEquity, getPlatformLedger } from '@/server/accounting/ledger';
import { publishActivity } from '@/server/ws/event-bus';
import { AUDIT_BROKER, recordAuditSafe } from '../audit/audit.service';
import { ensureBrokerConnected, getAdapterForConnection, makeActivity } from './broker.registry';
import type { BrokerPosition } from './broker.types';
import { resolvePositionInvestment } from './broker.sync';

/** What an operator sees for one connection. All figures are broker- or ledger-sourced. */
export interface BrokerReconciliation {
  connectionId: string;
  derivAccountId: string;
  maskedAccount: string;
  /**
   * The LAST broker-reported equity (the connection snapshot written by
   * `updateBrokerSnapshot`). Null when the broker reported none — never 0, which
   * would read as an empty account.
   */
  brokerEquity: number | null;
  /** Open positions the broker reports right now (`adapter.getOpenPositions()`). */
  brokerPositionCount: number;
  /** Ledger equity deployed with the broker. See the header for the derivation. */
  ledgerDeployedEquity: number;
  /** OPEN `TradeRecord` rows booked against this connection. */
  ledgerOpenCount: number;
  /** Contract ids the broker reports that the platform cannot attribute. */
  unattributedContractIds: string[];
  /**
   * broker equity − ledger deployed equity, in USD. Positive means the broker
   * holds more than the ledger accounts for. Null when the broker reported no
   * equity, i.e. there is nothing honest to compare against.
   */
  equityDrift: number | null;
  /** broker position count − ledger OPEN row count. */
  positionDrift: number;
  /** The thresholds this report was judged against. */
  thresholds: ReconcileThresholds;
  /** True when a drift breached a threshold (and was therefore alerted). */
  driftDetected: boolean;
  reconciledAt: string;
}

export interface ReconcileThresholds {
  /** Absolute USD tolerance on `equityDrift`. */
  equityDriftUsd: number;
  /** Absolute tolerance on `positionDrift` (0 = any mismatch). */
  positionDrift: number;
  /** Minimum seconds between two drift alerts for one connection. */
  alertCooldownSec: number;
}

/** Read a non-negative number from the environment, with a loud fallback. */
function envNumber(name: string, fallback: number): number {
  const raw = (process.env[name] ?? '').trim();
  if (raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.warn(
      `[broker.reconcile] ${name}="${raw}" is not a usable non-negative number; using the default ${fallback}.`,
    );
    return fallback;
  }
  return parsed;
}

/**
 * Alert thresholds, read per call so a redeploy (or a test) can change them.
 *
 * Defaults: $1.00 of equity drift (a real disagreement, not rounding — the sync
 * writes 2dp money and the broker reports cents), ANY position-count mismatch,
 * and a 15-minute cooldown between alerts for the same connection.
 */
export function reconcileThresholds(): ReconcileThresholds {
  return {
    equityDriftUsd: envNumber('BROKER_RECONCILE_EQUITY_DRIFT_USD', 1),
    positionDrift: envNumber('BROKER_RECONCILE_POSITION_DRIFT', 0),
    alertCooldownSec: envNumber('BROKER_RECONCILE_ALERT_COOLDOWN_SEC', 900),
  };
}

/** Redis key holding the last drift-alert timestamp for one connection. */
function driftAlertKey(derivAccountId: string): string {
  return rkey('broker-reconcile-alert', derivAccountId);
}

/**
 * Process-local backstop for the alert throttle. Redis is the cross-replica
 * throttle; if Redis is unreachable the alert must still not fire once per poll
 * on every replica, so each process also remembers when it last alerted.
 */
const lastDriftAlertAt = new Map<string, number>();

/**
 * The ledger's DEPLOYED equity, from the canonical accounting helpers.
 *
 * `confirmedDeposits: 0, withdrawals: 0` removes the two off-broker cash terms
 * from `EQUITY_FORMULA` (idle cash, and payouts which come out of idle cash).
 * They are intentional zeros chosen to exclude those terms, not substitutes for
 * missing data — every other input is the platform's own persisted figure.
 */
export async function ledgerDeployedEquity(): Promise<number> {
  const platform = await getPlatformLedger();
  const breakdown = computeEquity({
    startingCapital: platform.totalManagedCapital,
    realizedPnL: platform.realizedPnL,
    unrealizedPnL: platform.unrealizedPnL,
    deductedFees: platform.deductedFees,
    withdrawals: 0,
    confirmedDeposits: 0,
  });
  return usd(breakdown.equity).toNumber();
}

/**
 * Reconciles one connection. Read-only: it writes no ledger row and no snapshot.
 * The only write it may perform is the throttled drift alert.
 */
export async function reconcileBrokerConnection(
  conn: BrokerConnection,
): Promise<BrokerReconciliation> {
  const adapter = await ensureBrokerConnected(await getAdapterForConnection(conn));

  let positions: BrokerPosition[];
  try {
    positions = await adapter.getOpenPositions();
  } catch (err) {
    // Without the broker's own position list there is nothing to reconcile, and
    // an empty list would be an invented answer (it reads as "the account is
    // flat"). Report the failure instead.
    throw ApiError.brokerUnavailable(
      `Could not read open positions for ${conn.maskedAccount}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // Attribution through the SAME function the sync books with, so the report can
  // never disagree with what the sync actually did. Positions whose id resolves
  // to an investment that no longer exists are unattributed too (the sync counts
  // them the same way).
  const attributed: Array<{ positionId: string; investmentId: string }> = [];
  const unattributedContractIds: string[] = [];
  for (const position of positions) {
    const attribution = await resolvePositionInvestment(conn.id, position);
    if (attribution.investmentId === null) unattributedContractIds.push(position.positionId);
    else attributed.push({ positionId: position.positionId, investmentId: attribution.investmentId });
  }

  const investmentIds = [...new Set(attributed.map((row) => row.investmentId))];
  if (investmentIds.length > 0) {
    const known = await prisma.investment.findMany({
      where: { id: { in: investmentIds } },
      select: { id: true },
    });
    const knownIds = new Set(known.map((row) => row.id));
    for (const row of attributed) {
      if (!knownIds.has(row.investmentId)) unattributedContractIds.push(row.positionId);
    }
  }

  const ledgerOpenCount = await prisma.tradeRecord.count({
    where: { brokerId: conn.id, status: 'OPEN' },
  });
  const ledgerEquity = await ledgerDeployedEquity();

  const brokerEquity = conn.equity === null ? null : usd(conn.equity).toNumber();
  // Null when the broker reported nothing: an equity of 0 would be a fabricated
  // figure and would make the drift look like the whole account went missing.
  const equityDrift = brokerEquity === null ? null : usd(D(brokerEquity).minus(ledgerEquity)).toNumber();
  const positionDrift = positions.length - ledgerOpenCount;

  const thresholds = reconcileThresholds();
  // Equity is only judged when the broker actually reported one. A missing
  // snapshot is surfaced by `brokerEquity: null`, not by a fabricated drift.
  const equityBreach =
    equityDrift !== null && D(equityDrift).abs().greaterThan(D(thresholds.equityDriftUsd));
  const positionBreach = Math.abs(positionDrift) > thresholds.positionDrift;
  const driftDetected = equityBreach || positionBreach;

  const report: BrokerReconciliation = {
    connectionId: conn.id,
    derivAccountId: conn.derivAccountId,
    maskedAccount: conn.maskedAccount,
    brokerEquity,
    brokerPositionCount: positions.length,
    ledgerDeployedEquity: ledgerEquity,
    ledgerOpenCount,
    unattributedContractIds,
    equityDrift,
    positionDrift,
    thresholds,
    driftDetected,
    reconciledAt: new Date().toISOString(),
  };

  if (driftDetected) await alertOnDrift(conn, report);

  return report;
}

/**
 * Records + publishes a drift alert, at most once per cooldown window for one
 * connection. Deliberately NOT called on every reconcile: a report with no drift
 * writes nothing at all, and a persistent drift writes one row per cooldown
 * rather than one per poll.
 */
async function alertOnDrift(
  conn: BrokerConnection,
  report: BrokerReconciliation,
): Promise<void> {
  const cooldownMs = report.thresholds.alertCooldownSec * 1000;
  const now = Date.now();
  const previous = lastDriftAlertAt.get(conn.id) ?? 0;
  if (now - previous < cooldownMs) return;

  let reserved = true;
  try {
    const written = await redis.set(
      driftAlertKey(conn.derivAccountId),
      new Date(now).toISOString(),
      'EX',
      Math.max(1, Math.trunc(report.thresholds.alertCooldownSec)),
      'NX',
    );
    reserved = written === 'OK';
  } catch (err) {
    // Redis is the cross-replica throttle only. The process-local check above has
    // already limited this replica, so an outage degrades to per-process
    // throttling instead of silencing the alert or storming the audit table.
    console.warn(
      `[broker.reconcile] alert throttle unavailable for ${conn.maskedAccount}:`,
      err instanceof Error ? err.message : err,
    );
  }
  if (!reserved) return;
  lastDriftAlertAt.set(conn.id, now);

  const details = {
    brokerConnectionId: conn.id,
    derivAccountId: conn.derivAccountId,
    maskedAccount: conn.maskedAccount,
    brokerEquity: report.brokerEquity,
    ledgerDeployedEquity: report.ledgerDeployedEquity,
    equityDrift: report.equityDrift,
    brokerPositionCount: report.brokerPositionCount,
    ledgerOpenCount: report.ledgerOpenCount,
    positionDrift: report.positionDrift,
    unattributedContractIds: report.unattributedContractIds,
    // Spread into a plain object literal: Prisma's JSON input type rejects an
    // interface-typed value (no index signature), and this keeps the row
    // self-describing about the limits it was judged against.
    thresholds: {
      equityDriftUsd: report.thresholds.equityDriftUsd,
      positionDrift: report.thresholds.positionDrift,
      alertCooldownSec: report.thresholds.alertCooldownSec,
    },
    note: 'Broker-reported equity/positions disagree with the ledger beyond threshold. The reconciliation report is read-only; this row is the alert for an operator to investigate.',
  };

  await recordAuditSafe({
    action: AUDIT_BROKER.BROKER_RECONCILIATION_DRIFT,
    details,
  });

  await publishActivity(
    makeActivity(
      'BROKER_RECONCILIATION_DRIFT',
      `Broker ${conn.maskedAccount} does not reconcile: ` +
        (report.equityDrift === null
          ? 'the broker reported no equity'
          : `equity drift ${report.equityDrift.toFixed(2)} USD (broker ${report.brokerEquity} vs ledger ${report.ledgerDeployedEquity})`) +
        `, ${report.brokerPositionCount} broker position(s) vs ${report.ledgerOpenCount} booked open trade(s)` +
        (report.unattributedContractIds.length > 0
          ? `, ${report.unattributedContractIds.length} unattributed contract(s)`
          : '') +
        '.',
      'warning',
      details,
    ),
  );
}
