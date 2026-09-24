'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Activity, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from '@/components/ui/use-toast';
import { AdminApiError, errorMessage, adminRequest } from '@/components/admin/api-client';
import type { BrokerProbeResult } from '@/components/admin/types';
import { cn } from '@/lib/utils';

export interface LatencyProbeCellProps {
  connectionId: string;
  /**
   * The latency reported by the page's read. It is `null` unless a probe ran in
   * that request — `null` means "not measured", never a fabricated number.
   */
  initialLatencyMs: number | null;
  brokerName: string;
  className?: string;
}

/**
 * The latency cell of a broker connection.
 *
 * A latency figure only ever comes from `GET /api/v1/admin/brokers/:id/status`,
 * which performs a real broker round-trip (`adapter.ping()`). Probes are
 * never run implicitly — they connect an adapter — so the cell starts at "—" and
 * the number appears only after a probe actually returned one. A probe that fails
 * keeps the dash and says so.
 */
export function LatencyProbeCell({
  connectionId,
  initialLatencyMs,
  brokerName,
  className,
}: LatencyProbeCellProps) {
  const router = useRouter();
  const [latencyMs, setLatencyMs] = React.useState<number | null>(initialLatencyMs);
  const [pending, setPending] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    // The server-rendered page is the authority whenever it re-renders.
    setLatencyMs(initialLatencyMs);
    setFailed(false);
  }, [initialLatencyMs, connectionId]);

  const probe = async () => {
    setPending(true);
    try {
      const result = await adminRequest<BrokerProbeResult>(
        `/api/v1/admin/brokers/${encodeURIComponent(connectionId)}/status`,
        { method: 'GET' },
      );
      if (result.latencyMs === null) {
        setLatencyMs(null);
        setFailed(true);
        toast({
          variant: 'warn',
          title: 'No latency recorded',
          description:
            `${brokerName}: the RPC probe did not complete, so no latency figure was stored. ` +
            'A failed probe is never reported as a number.',
        });
      } else {
        setLatencyMs(result.latencyMs);
        setFailed(false);
        toast({
          variant: 'success',
          title: `Round-trip ${result.latencyMs} ms`,
          description: `${brokerName}: measured by a live broker round-trip (adapter.ping). Stored status: ${result.status}.`,
        });
      }
      router.refresh();
    } catch (error) {
      setFailed(true);
      toast({
        variant: 'danger',
        title: 'Probe failed',
        description: errorMessage(error),
      });
    } finally {
      setPending(false);
    }
  };

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              'tabular-nums text-sm',
              latencyMs === null ? 'text-muted' : 'text-base-100',
            )}
          >
            {latencyMs === null ? '—' : `${latencyMs} ms`}
          </span>
        </TooltipTrigger>
        <TooltipContent>
          {latencyMs === null
            ? failed
              ? 'The last probe could not complete. Nothing is estimated — re-probe to try again.'
              : 'Not probed in this request. A probe performs a real broker round-trip.'
            : 'Measured by a real broker round-trip (adapter.ping).'}
        </TooltipContent>
      </Tooltip>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={probe}
        disabled={pending}
        aria-label={`Probe latency for ${brokerName}`}
      >
        {pending ? (
          <RefreshCw aria-hidden className="animate-spin" />
        ) : (
          <Activity aria-hidden />
        )}
        {pending ? 'Probing' : latencyMs === null ? 'Probe latency' : 'Re-probe'}
      </Button>
    </div>
  );
}

export default LatencyProbeCell;
