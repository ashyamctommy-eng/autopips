'use client';

import * as React from 'react';
import { useRouter } from '@/lib/next/navigation';
import { Rocket } from 'lucide-react';

import { RiskBadge } from '@/components/shared/risk-badge';
import { TargetRange } from '@/components/shared/disclaimer';
import { Usd } from '@/components/shared/money';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/use-toast';
import { apiFetch } from '@/lib/session-refresh';
import type { InvestmentDTO, TradingPlanDTO } from '@/types/api';

/**
 * Client-side capital deployment.
 *
 * Lists every ACTIVE plan and lets the client move part of their withdrawable
 * balance into one. This is the ONLY client surface that creates an investment
 * (`POST /api/v1/account/investments`).
 *
 * The form mirrors the server's own rules rather than replacing them: the plan's
 * minimum and maximum and the caller's withdrawable balance are checked here for
 * a fast, specific message, but the server re-checks all of them (plan bounds, the
 * locked-balance ledger check, KYC-on-withdrawal) and its error is what is shown
 * if the two ever disagree.
 */

export interface PlanAllocatorProps {
  plans: TradingPlanDTO[];
  /** Withdrawable balance the client may deploy right now, in USD. */
  availableUsd: number;
  /** Existing investments, so already-deployed capital is visible per plan. */
  investments: InvestmentDTO[];
}

/** Pull the server's message out of the `{ ok:false, error }` envelope. */
function errorMessage(body: unknown, fallback: string): string {
  if (typeof body === 'object' && body !== null) {
    const envelope = body as { ok?: unknown; error?: unknown };
    if (envelope.ok === false) {
      const error = envelope.error as { message?: unknown } | null | undefined;
      if (typeof error?.message === 'string' && error.message.trim() !== '') return error.message;
    }
  }
  return fallback;
}

function money(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(value);
}

export function PlanAllocator({ plans, availableUsd, investments }: PlanAllocatorProps) {
  const router = useRouter();
  const [openPlanId, setOpenPlanId] = React.useState<string | null>(null);
  const [amount, setAmount] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Capital already running per plan (active + paused), so a client does not
  // deploy into a plan they have forgotten they are in.
  const deployedByPlan = React.useMemo(() => {
    const totals = new Map<string, number>();
    for (const investment of investments) {
      if (investment.status === 'ACTIVE' || investment.status === 'PAUSED') {
        totals.set(investment.planId, (totals.get(investment.planId) ?? 0) + investment.capitalUsd);
      }
    }
    return totals;
  }, [investments]);

  const openForm = (plan: TradingPlanDTO) => {
    setOpenPlanId(plan.id);
    setError(null);
    const suggested = availableUsd > 0 ? Math.min(plan.minInvestment, availableUsd) : plan.minInvestment;
    setAmount(String(suggested));
  };

  const closeForm = () => {
    if (busy) return;
    setOpenPlanId(null);
    setAmount('');
    setError(null);
  };

  const submit = async (plan: TradingPlanDTO) => {
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      setError('Enter an amount greater than zero.');
      return;
    }
    if (value < plan.minInvestment) {
      setError(`The minimum for ${plan.name} is ${money(plan.minInvestment)}.`);
      return;
    }
    if (value > plan.maxInvestment) {
      setError(`The maximum for ${plan.name} is ${money(plan.maxInvestment)}.`);
      return;
    }
    if (value > availableUsd) {
      setError(`You can deploy at most ${money(availableUsd)} right now.`);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const response = await apiFetch('/api/v1/account/investments', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ planId: plan.id, amountUsd: value }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        setError(errorMessage(body, 'The capital could not be deployed. Please try again.'));
        return;
      }
      toast({
        variant: 'success',
        title: 'Capital deployed',
        description: `${money(value)} is now running in ${plan.name}.`,
      });
      setOpenPlanId(null);
      setAmount('');
      router.refresh();
    } catch {
      setError('Network error — the capital was not deployed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {availableUsd <= 0 ? (
        <Alert variant="warn">
          <AlertTitle>No idle cash to deploy</AlertTitle>
          <AlertDescription>
            Capital is deployed from your withdrawable balance. Deposit funds first, or wait for an
            existing strategy to release capital.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {plans.map((plan) => {
          const deployed = deployedByPlan.get(plan.id) ?? 0;
          const isOpen = openPlanId === plan.id;
          const maxHere = Math.min(plan.maxInvestment, Math.max(0, availableUsd));
          return (
            <Card key={plan.id} className="flex flex-col">
              <CardHeader className="flex flex-row items-start justify-between gap-3 p-5 pb-3">
                <div className="min-w-0">
                  <CardTitle className="truncate text-sm">{plan.name}</CardTitle>
                  <p className="mt-1 text-xs text-muted">{plan.durationDays}-day term</p>
                </div>
                <RiskBadge level={plan.riskLevel} />
              </CardHeader>

              <CardContent className="flex flex-1 flex-col gap-4 p-5 pt-0">
                <p className="text-xs leading-relaxed text-muted">{plan.description}</p>

                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-xs uppercase tracking-wide text-muted">Deploy range</span>
                    <span className="tabular-nums text-base-100">
                      {money(plan.minInvestment)}–{money(plan.maxInvestment)}
                    </span>
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <span className="text-xs uppercase tracking-wide text-muted">Max drawdown</span>
                    <span className="tabular-nums text-base-100">{plan.maxDrawdown}%</span>
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <span className="text-xs uppercase tracking-wide text-muted">Perf. fee</span>
                    <span className="tabular-nums text-base-100">{plan.performanceFee}%</span>
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <span className="text-xs uppercase tracking-wide text-muted">Mgmt. fee</span>
                    <span className="tabular-nums text-base-100">{plan.managementFee}%</span>
                  </div>
                </div>

                <TargetRange min={plan.targetReturnMin} max={plan.targetReturnMax} />

                {deployed > 0 ? (
                  <p className="text-xs text-muted">
                    Already running:{' '}
                    <Usd value={deployed} tone="neutral" className="text-xs" /> in this plan.
                  </p>
                ) : null}

                {isOpen ? (
                  <div className="flex flex-col gap-3 rounded-lg border border-line bg-base-900/60 p-3">
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor={`deploy-amount-${plan.id}`}>Amount to deploy (USD)</Label>
                      <Input
                        id={`deploy-amount-${plan.id}`}
                        type="number"
                        inputMode="decimal"
                        min={plan.minInvestment}
                        max={maxHere}
                        step="0.01"
                        value={amount}
                        onChange={(event) => setAmount(event.target.value)}
                        placeholder={`${plan.minInvestment}–${maxHere}`}
                        disabled={busy}
                      />
                      <p className="text-xs text-muted">
                        Available to deploy: {money(availableUsd)} · Plan range:{' '}
                        {money(plan.minInvestment)}–{money(plan.maxInvestment)}
                      </p>
                    </div>

                    {error ? (
                      <Alert variant="warn">
                        <AlertDescription>{error}</AlertDescription>
                      </Alert>
                    ) : null}

                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="primary"
                        size="sm"
                        className="h-10 sm:h-8"
                        onClick={() => void submit(plan)}
                        disabled={busy}
                      >
                        <Rocket aria-hidden />
                        {busy ? 'Deploying…' : 'Deploy capital'}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-10 sm:h-8"
                        onClick={closeForm}
                        disabled={busy}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    variant="primary"
                    size="sm"
                    className="mt-auto h-10 sm:h-8"
                    onClick={() => openForm(plan)}
                    disabled={availableUsd <= 0}
                  >
                    <Rocket aria-hidden />
                    Deploy capital
                  </Button>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

export default PlanAllocator;
