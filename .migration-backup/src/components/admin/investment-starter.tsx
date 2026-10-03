'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { LineChart, Play } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from '@/components/ui/use-toast';
import { adminRequest, errorMessage } from '@/components/admin/api-client';

/**
 * Start an investment for a client (operator onboarding).
 *
 * The client's own invest call needs an APPROVED KYC record, and that gate is
 * right — this action replaces the client's assertion with the operator's and
 * records it as such in the audit trail. The plan's own min/max still apply, as
 * does the ledger's balance check: an operator cannot deploy money the client
 * does not hold.
 */

export interface StarterPlan {
  id: string;
  name: string;
  minInvestment: number;
  maxInvestment: number;
}

export interface InvestmentStarterProps {
  plans: StarterPlan[];
}

export function InvestmentStarter({ plans }: InvestmentStarterProps) {
  const router = useRouter();
  const [email, setEmail] = React.useState('');
  const [planId, setPlanId] = React.useState(plans[0]?.id ?? '');
  const [amount, setAmount] = React.useState('');
  const [reason, setReason] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const plan = plans.find((candidate) => candidate.id === planId) ?? null;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await adminRequest('/api/v1/admin/investments', {
        method: 'POST',
        body: {
          email: email.trim().toLowerCase(),
          plan_id: planId,
          amount_usd: Number(amount),
          reason: reason.trim(),
        },
      });
      toast({
        variant: 'success',
        title: 'Investment started',
        description: `${amount} USD deployed for ${email.trim().toLowerCase()}.`,
      });
      setAmount('');
      setReason('');
      router.refresh();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader className="p-5 pb-3">
        <CardTitle className="flex items-center gap-2">
          <LineChart aria-hidden className="size-4 text-brand-400" />
          Start an investment for a client
        </CardTitle>
        <p className="mt-1 text-xs leading-relaxed text-muted">
          Deploys a client&apos;s balance into a plan on their behalf — for onboarding completed
          offline, or for a funded test account. The client&apos;s own invest button requires an
          approved KYC record; this replaces that assertion with yours, and the audit trail records
          your identity, your reason and their KYC status at the time.
        </p>
      </CardHeader>

      <CardContent className="grid gap-4 p-5 pt-2 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="start-email">Client email</Label>
          <Input
            id="start-email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="client@example.com"
            disabled={busy}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="start-plan">Plan</Label>
          <Select value={planId} onValueChange={setPlanId} disabled={busy || plans.length === 0}>
            <SelectTrigger id="start-plan">
              <SelectValue placeholder={plans.length === 0 ? 'No active plan' : 'Select'} />
            </SelectTrigger>
            <SelectContent>
              {plans.map((candidate) => (
                <SelectItem key={candidate.id} value={candidate.id}>
                  {candidate.name} ({candidate.minInvestment}–{candidate.maxInvestment} USD)
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="start-amount">Amount (USD)</Label>
          <Input
            id="start-amount"
            type="number"
            min={plan?.minInvestment ?? 0}
            max={plan?.maxInvestment}
            step="0.01"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder={plan ? `${plan.minInvestment}–${plan.maxInvestment}` : '50'}
            disabled={busy}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="start-reason">Reason</Label>
          <Input
            id="start-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="e.g. funded test account to watch the engine"
            disabled={busy}
          />
        </div>

        <div className="sm:col-span-2">
          <Alert variant="warn">
            <AlertTitle>This moves real ledger money</AlertTitle>
            <AlertDescription>
              The client&apos;s balance must cover it — capital already deployed cannot be invested
              again. The plan&apos;s own minimum and maximum apply, and a client whose KYC was
              rejected cannot be funded at all.
              {error ? ` ${error}` : ''}
            </AlertDescription>
          </Alert>
        </div>

        <div className="sm:col-span-2">
          <Button
            variant="primary"
            onClick={() => void submit()}
            disabled={
              busy ||
              plans.length === 0 ||
              email.trim().length < 5 ||
              !planId ||
              !amount ||
              reason.trim().length < 3
            }
          >
            <Play aria-hidden />
            {busy ? 'Starting…' : 'Start investment'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
