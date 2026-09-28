import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { SignedUsd, Usd } from '@/components/shared/money';
import { ClosePositionButton } from '@/components/dashboard/close-position-button';
import { relativeTime } from '@/lib/utils';
import { sortInternalPositions } from '@/lib/order-ticket';
import type { InternalPositionDTO } from '@/types/api';

/**
 * The internal book — positions the platform itself is holding.
 *
 * This is a different table from the broker positions on `/dashboard/positions`:
 * those are `TradeRecord` rows tied to an investment and a broker connection,
 * while these are `Position` rows the internal engine opened against the client's
 * own stake. Both are real money, so both are shown, and neither list pretends to
 * be the other.
 *
 * The mark (`currentPrice`) and the P/L come from the tick engine's last stored
 * mark; they are not recomputed here from a chart. Unrealized while the position
 * is open.
 */

const priceFormatter = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 5,
});

export interface InternalPositionsProps {
  positions: InternalPositionDTO[];
  emptyDescription?: string;
}

export function InternalPositions({
  positions,
  emptyDescription = 'Nothing is held on the internal book right now. Positions opened from the order ticket appear here immediately.',
}: InternalPositionsProps) {
  const rows = sortInternalPositions(positions);

  return (
    <Card>
      <CardHeader className="p-5 pb-2">
        <CardTitle>Internal book</CardTitle>
        <p className="mt-1 text-xs leading-relaxed text-muted">
          Positions executed by the platform&apos;s own engine, marked to the last price the tick
          engine stored. The stake is the maximum each one can lose.
        </p>
      </CardHeader>
      <CardContent className="p-5 pt-2">
        {rows.length === 0 ? (
          <EmptyState size="sm" title="No internal positions" description={emptyDescription} />
        ) : (
          <ul className="flex flex-col divide-y divide-line/60">
            {rows.map((position) => (
              <li key={position.id} className="flex flex-wrap items-start gap-3 py-3">
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-base-100">{position.symbol}</span>
                    <span
                      className={
                        position.side === 'BUY'
                          ? 'rounded border border-profit/30 bg-profit/10 px-1.5 py-0.5 text-[0.68rem] font-semibold text-profit-400'
                          : 'rounded border border-loss/30 bg-loss/10 px-1.5 py-0.5 text-[0.68rem] font-semibold text-loss-400'
                      }
                    >
                      {position.side}
                    </span>
                    <span className="rounded border border-line bg-base-900/70 px-1.5 py-0.5 font-mono text-[0.68rem] text-muted">
                      {position.multiplier}x
                    </span>
                    <time
                      dateTime={position.openedAt}
                      suppressHydrationWarning
                      className="ml-auto text-[0.68rem] tabular-nums text-muted"
                    >
                      {relativeTime(position.openedAt)}
                    </time>
                  </div>

                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
                    <span>
                      Stake <Usd value={position.stake} tone="neutral" />
                    </span>
                    <span>
                      Entry <span className="font-mono tabular-nums text-base-100">{priceFormatter.format(position.entryPrice)}</span>
                    </span>
                    <span>
                      Mark <span className="font-mono tabular-nums text-base-100">{priceFormatter.format(position.currentPrice)}</span>
                    </span>
                    {position.stopLoss === null ? null : (
                      <span>
                        SL <span className="font-mono tabular-nums text-loss-400">{priceFormatter.format(position.stopLoss)}</span>
                      </span>
                    )}
                    {position.takeProfit === null ? null : (
                      <span>
                        TP <span className="font-mono tabular-nums text-profit-400">{priceFormatter.format(position.takeProfit)}</span>
                      </span>
                    )}
                    <span className="inline-flex items-center gap-1">
                      Unrealized <SignedUsd value={position.pnl} />
                    </span>
                  </div>
                </div>

                <ClosePositionButton positionId={position.id} symbol={position.symbol} />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export default InternalPositions;
