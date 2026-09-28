'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { apiFetch } from '@/lib/session-refresh';

/**
 * Close an internal position at the current market price.
 *
 * `POST /api/v1/positions/:id/close` resolves the fill server-side and closes
 * whatever is still OPEN — the compare-and-swap in the service decides the winner
 * if a stop or target fills at the same moment, so this button cannot be used to
 * race a protective order.
 *
 * After a successful close the server components are re-rendered
 * (`router.refresh()`), because the open book is rendered from the database
 * rather than from a client cache — and internal positions deliberately publish
 * no live event yet, so there is nothing to fold in optimistically.
 */

export interface ClosePositionButtonProps {
  positionId: string;
  symbol: string;
}

function envelopeError(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const envelope = body as { ok?: unknown; error?: unknown };
  if (envelope.ok !== false) return null;
  const error = envelope.error as { message?: unknown } | null | undefined;
  return typeof error?.message === 'string' ? error.message : null;
}

export function ClosePositionButton({ positionId, symbol }: ClosePositionButtonProps) {
  const router = useRouter();
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const close = async (): Promise<void> => {
    setSubmitting(true);
    setError(null);
    try {
      const response = await apiFetch(`/api/v1/positions/${positionId}/close`, {
        method: 'POST',
        credentials: 'include',
      });
      const payload: unknown = await response.json();
      if (!response.ok) {
        setError(
          envelopeError(payload) ?? `The position was not closed (HTTP ${response.status}).`,
        );
        return;
      }
      router.refresh();
    } catch {
      setError('The close request could not be completed. Try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={submitting}
        onClick={() => void close()}
        aria-label={`Close ${symbol} at the market price`}
      >
        {submitting ? <Spinner size="sm" label="Closing" /> : 'Close'}
      </Button>
      {error ? <span className="max-w-[14rem] text-right text-[0.68rem] text-loss-400">{error}</span> : null}
    </div>
  );
}

export default ClosePositionButton;
