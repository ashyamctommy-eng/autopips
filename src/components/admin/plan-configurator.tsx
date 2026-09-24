'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { CircleOff, FileJson, Layers, Pencil, Plus, TriangleAlert } from 'lucide-react';
import type { ZodIssue } from 'zod';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/use-toast';
import { NonGuaranteedNote, TargetRange } from '@/components/shared/disclaimer';
import { Pct, Usd } from '@/components/shared/money';
import { RiskBadge } from '@/components/shared/risk-badge';
import { adminRequest, errorMessage } from '@/components/admin/api-client';
import { RISK_LEVELS, type RiskLevel } from '@/lib/contracts';
import { cn } from '@/lib/utils';
import type { TradingPlanDTO } from '@/types/api';
// The plan contract is plain zod + `src/lib/contracts` (no server-only imports),
// so the create/update schemas are shared verbatim with the server instead of
// being re-implemented here. Client-side validation therefore cannot drift from
// what `admin.service.createPlan/updatePlan` will accept.
import {
  PLAN_EXAMPLE,
  PLAN_FIELD_GUIDE,
  planInputSchema,
  planUpdateSchema,
} from '@/server/modules/admin/plan-validation';

const RISK_LABEL: Record<RiskLevel, string> = {
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
};

interface PlanFormState {
  name: string;
  description: string;
  minInvestment: string;
  maxInvestment: string;
  durationDays: string;
  targetReturnMin: string;
  targetReturnMax: string;
  riskLevel: RiskLevel;
  performanceFee: string;
  managementFee: string;
  maxDrawdown: string;
  isActive: boolean;
}

type FieldErrors = Record<string, string>;

function emptyForm(): PlanFormState {
  return {
    name: '',
    description: '',
    minInvestment: '',
    maxInvestment: '',
    durationDays: '',
    targetReturnMin: '',
    targetReturnMax: '',
    riskLevel: 'MEDIUM',
    performanceFee: '',
    managementFee: '',
    maxDrawdown: '',
    isActive: true,
  };
}

function formFromPlan(plan: TradingPlanDTO): PlanFormState {
  return {
    name: plan.name,
    description: plan.description,
    minInvestment: String(plan.minInvestment),
    maxInvestment: String(plan.maxInvestment),
    durationDays: String(plan.durationDays),
    targetReturnMin: String(plan.targetReturnMin),
    targetReturnMax: String(plan.targetReturnMax),
    riskLevel: (RISK_LEVELS as readonly string[]).includes(plan.riskLevel)
      ? (plan.riskLevel as RiskLevel)
      : 'MEDIUM',
    performanceFee: String(plan.performanceFee),
    managementFee: String(plan.managementFee),
    maxDrawdown: String(plan.maxDrawdown),
    isActive: plan.isActive,
  };
}

/** `''` becomes NaN, which the shared zod schema rejects as "must be a number". */
/** The illustrative plan, as form strings (every numeric input is controlled text). */
function formFromExample(): PlanFormState {
  return {
    name: PLAN_EXAMPLE.name,
    description: PLAN_EXAMPLE.description,
    minInvestment: String(PLAN_EXAMPLE.minInvestment),
    maxInvestment: String(PLAN_EXAMPLE.maxInvestment),
    durationDays: String(PLAN_EXAMPLE.durationDays),
    targetReturnMin: String(PLAN_EXAMPLE.targetReturnMin),
    targetReturnMax: String(PLAN_EXAMPLE.targetReturnMax),
    riskLevel: PLAN_EXAMPLE.riskLevel,
    performanceFee: String(PLAN_EXAMPLE.performanceFee),
    managementFee: String(PLAN_EXAMPLE.managementFee),
    maxDrawdown: String(PLAN_EXAMPLE.maxDrawdown),
    isActive: PLAN_EXAMPLE.isActive,
  };
}

function toNumber(value: string): number {
  const trimmed = value.trim();
  return trimmed === '' ? Number.NaN : Number(trimmed);
}

function toPayload(form: PlanFormState): Record<string, unknown> {
  return {
    name: form.name.trim(),
    description: form.description.trim(),
    minInvestment: toNumber(form.minInvestment),
    maxInvestment: toNumber(form.maxInvestment),
    durationDays: toNumber(form.durationDays),
    targetReturnMin: toNumber(form.targetReturnMin),
    targetReturnMax: toNumber(form.targetReturnMax),
    riskLevel: form.riskLevel,
    performanceFee: toNumber(form.performanceFee),
    managementFee: toNumber(form.managementFee),
    maxDrawdown: toNumber(form.maxDrawdown),
    isActive: form.isActive,
  };
}

function errorsFromIssues(issues: ZodIssue[]): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of issues) {
    const field = issue.path[0] === undefined ? 'form' : String(issue.path[0]);
    if (!(field in errors)) errors[field] = issue.message;
  }
  return errors;
}

const fieldClass = (errors: FieldErrors, field: keyof PlanFormState | string): string | undefined =>
  field in errors ? 'border-loss/60 focus-visible:border-loss/60' : undefined;

function FieldError({ errors, field }: { errors: FieldErrors; field: string }) {
  if (!(field in errors)) return null;
  return <p className="text-xs text-loss-400">{errors[field]}</p>;
}

/**
 * Format reference shown while CREATING a plan.
 *
 * The example is `PLAN_EXAMPLE` from the plan contract itself, so the field
 * names, units and ranges here are the ones the API accepts — a test asserts the
 * example against `planInputSchema` so it cannot drift. The button fills the form
 * with it, which is the quickest honest answer to "what shape do you want?".
 */
function ExampleFormatPanel({ onUse }: { onUse: () => void }) {
  const [showFields, setShowFields] = React.useState(false);

  return (
    <div className="rounded-lg border border-line bg-base-800/60 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <FileJson aria-hidden className="size-4 text-brand-400" />
          <span className="text-sm font-medium text-base-100">Example format</span>
          <Badge variant="outline">illustrative values</Badge>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setShowFields((value) => !value)}
          >
            {showFields ? 'Hide field rules' : 'Show field rules'}
          </Button>
          <Button type="button" size="sm" variant="secondary" onClick={onUse}>
            Use this example
          </Button>
        </div>
      </div>

      <p className="mt-2 text-xs text-muted">
        The exact payload the API accepts. Amounts are USD; returns, fees and drawdown are
        percentages. Target returns are an indicative range, not a promise of performance.
      </p>

      {showFields ? (
        <ul className="mt-3 flex flex-col gap-1.5">
          {PLAN_FIELD_GUIDE.map((entry) => (
            <li key={entry.field} className="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
              <code className="shrink-0 font-mono text-xs text-brand-300 sm:w-44">
                {entry.field}
              </code>
              <span className="text-xs text-muted">{entry.rule}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <pre className="mt-3 max-h-56 overflow-auto rounded-md border border-line bg-base-900 p-3 font-mono text-xs leading-relaxed text-base-100">
        {JSON.stringify(PLAN_EXAMPLE, null, 2)}
      </pre>
    </div>
  );
}

export interface PlanConfiguratorProps {
  initialPlans: TradingPlanDTO[];
  /** Creating/updating a plan is ADMIN-only in the API. */
  canManage: boolean;
}

/**
 * Trading plan list + create/edit dialog.
 *
 * Two honesty rules are enforced here:
 *   1. target returns are only ever rendered through `<TargetRange>` (or with an
 *      adjacent `<NonGuaranteedNote>` in the form), so an indicative figure can
 *      never be published without its caveat;
 *   2. a plan's live stats are shown only when the strategy actually has closed
 *      trades — otherwise the row says "no verified track record", because a win
 *      rate of 0% or 100% with no trades would both be fabrications.
 */
export function PlanConfigurator({ initialPlans, canManage }: PlanConfiguratorProps) {
  const router = useRouter();

  const [plans, setPlans] = React.useState<TradingPlanDTO[]>(initialPlans);
  const [reloading, setReloading] = React.useState(false);

  const [editing, setEditing] = React.useState<TradingPlanDTO | null>(null);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [form, setForm] = React.useState<PlanFormState>(emptyForm);
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [confirmDeactivate, setConfirmDeactivate] = React.useState(false);

  const loadPlans = React.useCallback(async () => {
    setReloading(true);
    try {
      const data = await adminRequest<TradingPlanDTO[]>('/api/v1/admin/plans');
      setPlans(data);
    } catch (caught) {
      toast({ variant: 'danger', title: 'Could not refresh plans', description: errorMessage(caught) });
    } finally {
      setReloading(false);
    }
  }, []);

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm());
    setErrors({});
    setFormError(null);
    setDialogOpen(true);
  };

  const openEdit = (plan: TradingPlanDTO) => {
    setEditing(plan);
    setForm(formFromPlan(plan));
    setErrors({});
    setFormError(null);
    setDialogOpen(true);
  };

  const validate = (payload: Record<string, unknown>): FieldErrors => {
    if (editing) {
      const patch = planUpdateSchema.safeParse(payload);
      if (!patch.success) return errorsFromIssues(patch.error.issues);
      // The service re-validates the merged plan; this mirrors that check for the
      // cross-field rules (max > min, target max ≥ target min) so the operator
      // sees the problem before the request.
      const complete = planInputSchema.safeParse(payload);
      return complete.success ? {} : errorsFromIssues(complete.error.issues);
    }
    const parsed = planInputSchema.safeParse(payload);
    return parsed.success ? {} : errorsFromIssues(parsed.error.issues);
  };

  const submit = async () => {
    const payload = toPayload(form);
    const fieldErrors = validate(payload);
    if (Object.keys(fieldErrors).length > 0) {
      setErrors(fieldErrors);
      setFormError('Fix the highlighted fields — the plan was not saved.');
      return;
    }

    setSubmitting(true);
    setErrors({});
    setFormError(null);
    try {
      const saved = editing
        ? await adminRequest<TradingPlanDTO>(
            `/api/v1/admin/plans/${encodeURIComponent(editing.id)}`,
            { method: 'PATCH', body: payload },
          )
        : await adminRequest<TradingPlanDTO>('/api/v1/admin/plans', {
            method: 'POST',
            body: payload,
          });

      toast({
        variant: saved.isActive ? 'success' : 'warn',
        title: editing
          ? saved.isActive
            ? 'Plan updated'
            : 'Plan deactivated'
          : 'Plan created',
        description:
          `${saved.name} · ${saved.riskLevel} risk · audited as ` +
          `${editing ? (saved.isActive ? 'PLAN_UPDATED' : 'PLAN_DEACTIVATED') : 'PLAN_CREATED'}.`,
      });

      setDialogOpen(false);
      setEditing(null);
      await loadPlans();
      router.refresh();
    } catch (caught) {
      const fieldErrorsFromServer =
        caught instanceof Error && 'fieldErrors' in caught
          ? ((caught as { fieldErrors: FieldErrors }).fieldErrors ?? {})
          : {};
      setErrors(fieldErrorsFromServer);
      setFormError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  };

  const requestSubmit = () => {
    // Deactivating removes the plan from the client-facing catalogue, so it is
    // confirmed explicitly rather than applied on a stray click.
    if (editing && editing.isActive && !form.isActive) {
      const payload = toPayload(form);
      const fieldErrors = validate(payload);
      if (Object.keys(fieldErrors).length > 0) {
        setErrors(fieldErrors);
        setFormError('Fix the highlighted fields before deactivating.');
        return;
      }
      setConfirmDeactivate(true);
      return;
    }
    void submit();
  };

  const columns = React.useMemo<DataTableColumn<TradingPlanDTO>[]>(
    () => [
      {
        key: 'name',
        header: 'Plan',
        cell: (plan) => (
          <div className="flex max-w-[18rem] flex-col gap-0.5">
            <span className="flex items-center gap-2 text-sm font-medium text-base-100">
              {plan.name}
              {plan.isActive ? (
                <Badge variant="success">Active</Badge>
              ) : (
                <Badge variant="outline">Inactive</Badge>
              )}
            </span>
            <span className="line-clamp-2 text-xs leading-relaxed text-muted">{plan.description}</span>
          </div>
        ),
      },
      {
        key: 'risk',
        header: 'Risk',
        cell: (plan) => <RiskBadge level={plan.riskLevel} />,
      },
      {
        key: 'size',
        header: 'Capital range',
        cell: (plan) => (
          <span className="whitespace-nowrap text-sm text-base-100">
            <Usd value={plan.minInvestment} tone="neutral" /> –{' '}
            <Usd value={plan.maxInvestment} tone="neutral" />
          </span>
        ),
      },
      {
        key: 'duration',
        header: 'Duration',
        cell: (plan) => (
          <span className="tabular-nums text-sm text-muted">{plan.durationDays} days</span>
        ),
      },
      {
        key: 'target',
        header: 'Target return',
        cell: (plan) => (
          <TargetRange min={plan.targetReturnMin} max={plan.targetReturnMax} valueClassName="text-sm" />
        ),
      },
      {
        key: 'fees',
        header: 'Fees',
        cell: (plan) => (
          <div className="flex flex-col text-xs text-muted">
            <span>
              Perf <Pct value={plan.performanceFee} tone="neutral" className="text-xs text-base-100" />
            </span>
            <span>
              Mgmt <Pct value={plan.managementFee} tone="neutral" className="text-xs text-base-100" />
            </span>
          </div>
        ),
      },
      {
        key: 'drawdown',
        header: 'Max drawdown',
        cell: (plan) => <Pct value={plan.maxDrawdown} tone="neutral" className="text-sm" />,
      },
      {
        key: 'stats',
        header: 'Live track record',
        cell: (plan) =>
          plan.stats === null ? (
            <span className="text-xs text-muted">
              No verified track record yet — the strategy has no closed trades, so win rate and
              observed return are not reported.
            </span>
          ) : (
            <div className="flex flex-col gap-0.5 text-xs text-muted">
              <span>
                <span className="text-base-100">{plan.stats.closedTrades}</span> closed trades
              </span>
              <span>
                win rate{' '}
                {plan.stats.winRatePct === null ? (
                  <span>—</span>
                ) : (
                  <Pct value={plan.stats.winRatePct} tone="neutral" className="text-xs text-base-100" />
                )}
              </span>
              <span>
                observed return{' '}
                {plan.stats.observedReturnPct === null ? (
                  <span>—</span>
                ) : (
                  <Pct
                    value={plan.stats.observedReturnPct}
                    sign
                    tone="auto"
                    className="text-xs"
                  />
                )}
              </span>
              <span>
                max observed drawdown{' '}
                {plan.stats.maxObservedDrawdownPct === null ? (
                  <span>—</span>
                ) : (
                  <Pct
                    value={plan.stats.maxObservedDrawdownPct}
                    tone="neutral"
                    className="text-xs text-base-100"
                  />
                )}
              </span>
            </div>
          ),
      },
      {
        key: 'actions',
        header: '',
        align: 'right',
        cell: (plan) =>
          canManage ? (
            <Button variant="outline" size="sm" onClick={() => openEdit(plan)}>
              <Pencil aria-hidden />
              Edit
            </Button>
          ) : null,
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canManage],
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-xs leading-relaxed text-muted">
          Plans define the capital tiers, fees and the drawdown stop the bot engine enforces. Every
          target-return figure below is an indicative objective, never a promise — the caveat is part
          of the component that renders it.
        </p>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void loadPlans()} disabled={reloading}>
            Refresh
          </Button>
          {canManage ? (
            <Button variant="primary" onClick={openCreate}>
              <Plus aria-hidden />
              New plan
            </Button>
          ) : null}
        </div>
      </div>

      <DataTable<TradingPlanDTO>
        columns={columns}
        rows={plans}
        getRowKey={(plan) => plan.id}
        isLoading={reloading && plans.length === 0}
        skeletonRows={4}
        emptyState={
          <EmptyState
            icon={Layers}
            title="No trading plans yet"
            description="Create the first plan to publish a capital tier with its fees, duration and drawdown stop."
          />
        }
      />

      <NonGuaranteedNote variant="footnote" />

      <Dialog
        open={dialogOpen}
        onOpenChange={(next) => {
          if (!next && !submitting) {
            setDialogOpen(false);
            setEditing(null);
          }
        }}
      >
        <DialogContent className="max-h-[92vh] w-[min(96vw,48rem)] max-w-none overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? `Edit ${editing.name}` : 'New trading plan'}</DialogTitle>
            <DialogDescription>
              All monetary values are USD; target returns, fees and drawdown are percentages. The API
              re-validates every field and rejects a maximum investment below the minimum.
            </DialogDescription>
          </DialogHeader>

          {!editing ? (
            <ExampleFormatPanel
              onUse={() => {
                setForm(formFromExample());
                setErrors({});
                setFormError(null);
              }}
            />
          ) : null}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label htmlFor="plan-name">Name</Label>
              <Input
                id="plan-name"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                className={fieldClass(errors, 'name')}
                placeholder="e.g. Balanced Momentum"
              />
              <FieldError errors={errors} field="name" />
            </div>

            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label htmlFor="plan-description">Description</Label>
              <Textarea
                id="plan-description"
                value={form.description}
                onChange={(event) => setForm({ ...form, description: event.target.value })}
                className={cn('min-h-[88px]', fieldClass(errors, 'description'))}
                placeholder="What the strategy trades, its timeframe and how risk is controlled. Avoid promising outcomes."
              />
              <FieldError errors={errors} field="description" />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="plan-min">Minimum investment (USD)</Label>
              <Input
                id="plan-min"
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                value={form.minInvestment}
                onChange={(event) => setForm({ ...form, minInvestment: event.target.value })}
                className={fieldClass(errors, 'minInvestment')}
              />
              <FieldError errors={errors} field="minInvestment" />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="plan-max">Maximum investment (USD)</Label>
              <Input
                id="plan-max"
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                value={form.maxInvestment}
                onChange={(event) => setForm({ ...form, maxInvestment: event.target.value })}
                className={fieldClass(errors, 'maxInvestment')}
              />
              <FieldError errors={errors} field="maxInvestment" />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="plan-duration">Duration (days)</Label>
              <Input
                id="plan-duration"
                type="number"
                inputMode="numeric"
                min="1"
                step="1"
                value={form.durationDays}
                onChange={(event) => setForm({ ...form, durationDays: event.target.value })}
                className={fieldClass(errors, 'durationDays')}
              />
              <FieldError errors={errors} field="durationDays" />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="plan-risk">Risk level</Label>
              <Select
                value={form.riskLevel}
                onValueChange={(value) => setForm({ ...form, riskLevel: value as RiskLevel })}
              >
                <SelectTrigger id="plan-risk">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RISK_LEVELS.map((level) => (
                    <SelectItem key={level} value={level}>
                      {RISK_LABEL[level]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldError errors={errors} field="riskLevel" />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="plan-target-min">Minimum target return (%)</Label>
              <Input
                id="plan-target-min"
                type="number"
                inputMode="decimal"
                min="0"
                max="100"
                step="0.01"
                value={form.targetReturnMin}
                onChange={(event) => setForm({ ...form, targetReturnMin: event.target.value })}
                className={fieldClass(errors, 'targetReturnMin')}
              />
              <FieldError errors={errors} field="targetReturnMin" />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="plan-target-max">Maximum target return (%)</Label>
              <Input
                id="plan-target-max"
                type="number"
                inputMode="decimal"
                min="0"
                max="100"
                step="0.01"
                value={form.targetReturnMax}
                onChange={(event) => setForm({ ...form, targetReturnMax: event.target.value })}
                className={fieldClass(errors, 'targetReturnMax')}
              />
              <FieldError errors={errors} field="targetReturnMax" />
            </div>

            <div className="sm:col-span-2">
              <NonGuaranteedNote variant="inline" />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="plan-perf-fee">Performance fee (%)</Label>
              <Input
                id="plan-perf-fee"
                type="number"
                inputMode="decimal"
                min="0"
                max="100"
                step="0.01"
                value={form.performanceFee}
                onChange={(event) => setForm({ ...form, performanceFee: event.target.value })}
                className={fieldClass(errors, 'performanceFee')}
              />
              <FieldError errors={errors} field="performanceFee" />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="plan-mgmt-fee">Management fee (%)</Label>
              <Input
                id="plan-mgmt-fee"
                type="number"
                inputMode="decimal"
                min="0"
                max="100"
                step="0.01"
                value={form.managementFee}
                onChange={(event) => setForm({ ...form, managementFee: event.target.value })}
                className={fieldClass(errors, 'managementFee')}
              />
              <FieldError errors={errors} field="managementFee" />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="plan-drawdown">Maximum drawdown (%)</Label>
              <Input
                id="plan-drawdown"
                type="number"
                inputMode="decimal"
                min="0"
                max="100"
                step="0.01"
                value={form.maxDrawdown}
                onChange={(event) => setForm({ ...form, maxDrawdown: event.target.value })}
                className={fieldClass(errors, 'maxDrawdown')}
              />
              <p className="text-xs text-muted">
                The bot engine rejects every order once drawdown reaches this limit, so it must be
                greater than 0%.
              </p>
              <FieldError errors={errors} field="maxDrawdown" />
            </div>

            <div className="flex items-center justify-between gap-4 rounded-lg border border-line bg-base-900/40 p-3 sm:col-span-2">
              <div className="flex flex-col gap-0.5">
                <Label htmlFor="plan-active">Plan is active</Label>
                <span className="text-xs text-muted">
                  Inactive plans stay in this list but are not offered to clients. Existing
                  investments keep their terms.
                </span>
              </div>
              <Switch
                id="plan-active"
                checked={form.isActive}
                onCheckedChange={(checked) => setForm({ ...form, isActive: checked })}
              />
            </div>

            {formError ? (
              <div className="sm:col-span-2">
                <Alert variant="danger">
                  <AlertTitle>Plan not saved</AlertTitle>
                  <AlertDescription>{formError}</AlertDescription>
                </Alert>
              </div>
            ) : null}
          </div>

          <Separator />

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setDialogOpen(false);
                setEditing(null);
              }}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button variant="primary" onClick={requestSubmit} disabled={submitting}>
              {submitting ? 'Saving…' : editing ? 'Save changes' : 'Create plan'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={confirmDeactivate}
        onOpenChange={(next) => {
          if (!next) setConfirmDeactivate(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <TriangleAlert aria-hidden className="size-4 text-warn-400" />
              Deactivate {editing?.name}?
            </DialogTitle>
            <DialogDescription>
              A deactivated plan disappears from the client-facing catalogue and cannot receive new
              capital. The change is audited as PLAN_DEACTIVATED, and investments already running on
              this plan are unaffected.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDeactivate(false)} disabled={submitting}>
              <CircleOff aria-hidden />
              Keep it active
            </Button>
            <Button
              variant="destructive"
              disabled={submitting}
              onClick={() => {
                setConfirmDeactivate(false);
                void submit();
              }}
            >
              {submitting ? 'Deactivating…' : 'Deactivate plan'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default PlanConfigurator;
