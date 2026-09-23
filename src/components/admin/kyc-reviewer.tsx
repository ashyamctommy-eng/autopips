'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  Ban,
  CircleCheck,
  Clock,
  ExternalLink,
  FileWarning,
  Loader2,
  MessageSquareWarning,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/use-toast';
import { StatusBadge } from '@/components/shared/status-badge';
import { adminRequest, errorMessage } from '@/components/admin/api-client';
import {
  KYC_DOCUMENT_LABELS,
  KYC_ID_TYPE_LABELS,
  KYC_STATUS_TABS,
  ageFromIsoDate,
  type KycDetailView,
  type KycDocumentUrlEntry,
} from '@/components/admin/types';
import { cn, relativeTime } from '@/lib/utils';
import type { KycReviewRow, KycStatusValue } from '@/types/api';

type Decision = 'APPROVE' | 'REJECT' | 'REQUEST_MORE_INFO';

export interface KycReviewerProps {
  /** Queue for `initialStatus`, fetched server-side. */
  initialRows: KycReviewRow[];
  initialStatus: KycStatusValue;
  /** Deciding is ADMIN-only server-side; a TRADING_MANAGER sees the queue only. */
  canDecide: boolean;
}

function idTypeLabel(idType: string): string {
  return KYC_ID_TYPE_LABELS[idType] ?? idType;
}

/** A pre-signed S3 path is a PDF when the object key ends in `.pdf`. */
function looksLikePdf(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().endsWith('.pdf');
  } catch {
    return url.toLowerCase().includes('.pdf');
  }
}

function formatCountdown(msRemaining: number): string {
  const total = Math.max(0, Math.floor(msRemaining / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** The declared fields a reviewer compares against the documents. */
interface DeclaredRow {
  label: string;
  /** Null when the admin detail payload does not carry the field. */
  value: string | null;
}

function declaredRows(detail: KycDetailView): DeclaredRow[] {
  const dob = detail.dob;
  const age = dob ? ageFromIsoDate(dob) : null;
  return [
    { label: 'Legal name', value: detail.legalName },
    { label: 'Date of birth', value: dob ?? null },
    { label: 'Age declared', value: age === null ? null : `${age} years` },
    { label: 'Residential address', value: detail.address ?? null },
    { label: 'ID type', value: idTypeLabel(detail.idType) },
    { label: 'ID number', value: detail.idNumberMasked ?? null },
    { label: 'Account email', value: detail.email },
    { label: 'Account country', value: detail.country },
  ];
}

/**
 * One signed document.
 *
 * The URL comes from `GET /api/v1/admin/kyc/:id/files` — a pre-signed S3 GET
 * capped at 300 seconds. Nothing here can reach the private bucket directly and
 * the raw object key is never part of the payload, so it cannot leak into a
 * screenshot, a copy/paste or a devtools panel.
 */
function DocumentCard({
  kind,
  entry,
  uploaded,
  expired,
}: {
  kind: string;
  entry: KycDocumentUrlEntry | undefined;
  uploaded: boolean;
  expired: boolean;
}) {
  const [broken, setBroken] = React.useState(false);
  const label = KYC_DOCUMENT_LABELS[kind] ?? kind;

  React.useEffect(() => {
    setBroken(false);
  }, [entry?.url]);

  if (!uploaded && !entry) {
    return (
      <div className="flex flex-col gap-1 rounded-lg border border-dashed border-line bg-base-900/40 p-4">
        <span className="text-sm text-base-100">{label}</span>
        <span className="text-xs text-muted">Not provided with this submission.</span>
      </div>
    );
  }

  if (!entry) {
    return (
      <div className="flex flex-col gap-1 rounded-lg border border-line bg-base-900/40 p-4">
        <span className="text-sm text-base-100">{label}</span>
        <span className="text-xs text-muted">Uploaded — use “Refresh links” to open it.</span>
      </div>
    );
  }

  if (entry.url === null) {
    return (
      <div className="flex flex-col gap-1 rounded-lg border border-warn/30 bg-warn/[0.07] p-4">
        <span className="flex items-center gap-2 text-sm text-base-100">
          <FileWarning aria-hidden className="size-4 text-warn-400" />
          {label}
        </span>
        <span className="text-xs text-muted">
          {entry.error ?? 'No signed URL is available for this document.'} The stored object key was
          never exposed to the browser.
        </span>
      </div>
    );
  }

  if (expired) {
    return (
      <div className="flex flex-col gap-1 rounded-lg border border-line bg-base-900/40 p-4">
        <span className="text-sm text-base-100">{label}</span>
        <span className="text-xs text-warn-400">
          The signed link expired. Refresh to mint a new 5-minute link — that also writes a fresh
          KYC_DOCUMENT_VIEWED audit entry.
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-base-900/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-base-100">{label}</span>
        <a
          href={entry.url}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 text-xs text-brand-300 underline-offset-4 hover:underline"
        >
          <ExternalLink aria-hidden className="size-3" />
          Open in new tab
        </a>
      </div>

      {looksLikePdf(entry.url) ? (
        <object
          data={entry.url}
          type="application/pdf"
          className="h-64 w-full rounded border border-line bg-base-950"
          aria-label={`${label} (PDF)`}
        >
          <p className="p-3 text-xs text-muted">
            This browser cannot display the PDF inline. Use “Open in new tab”.
          </p>
        </object>
      ) : broken ? (
        <p className="rounded border border-line bg-base-950 p-3 text-xs text-muted">
          Inline preview unavailable for this file type. Use “Open in new tab”.
        </p>
      ) : (
        /* eslint-disable-next-line @next/next/no-img-element -- a short-lived signed URL cannot go through the image optimiser */
        <img
          src={entry.url}
          alt={`${label} submitted for identity verification`}
          onError={() => setBroken(true)}
          className="max-h-64 w-full rounded border border-line bg-base-950 object-contain"
        />
      )}
    </div>
  );
}

/**
 * KYC review queue + reviewer dialog.
 *
 * Workflow:
 *   1. the queue tab calls `GET /api/v1/admin/kyc?status=…` (oldest first),
 *   2. opening a row calls `GET /api/v1/admin/kyc/:id` for the declared profile,
 *   3. documents come from `GET /api/v1/admin/kyc/:id/files`, which mints
 *      300-second signed URLs and writes KYC_DOCUMENT_VIEWED for the fetch,
 *   4. the decision posts to `/api/v1/admin/kyc/:id/decision`.
 *
 * No document bytes pass through this bundle, no S3 key is received, and the
 * reviewer is told — inside the dialog — that opening documents is an audited
 * act.
 */
export function KycReviewer({ initialRows, initialStatus, canDecide }: KycReviewerProps) {
  const router = useRouter();

  const [status, setStatus] = React.useState<KycStatusValue>(initialStatus);
  const [rows, setRows] = React.useState<KycReviewRow[]>(initialRows);
  const [listLoading, setListLoading] = React.useState(false);
  const [listError, setListError] = React.useState<string | null>(null);

  const [selected, setSelected] = React.useState<KycReviewRow | null>(null);
  const [detail, setDetail] = React.useState<KycDetailView | null>(null);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [detailError, setDetailError] = React.useState<string | null>(null);

  const [files, setFiles] = React.useState<KycDocumentUrlEntry[] | null>(null);
  const [filesLoading, setFilesLoading] = React.useState(false);
  const [filesError, setFilesError] = React.useState<string | null>(null);
  const [expiresAt, setExpiresAt] = React.useState<number | null>(null);
  const [now, setNow] = React.useState<number>(0);

  const [reason, setReason] = React.useState('');
  const [decisionError, setDecisionError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState<Decision | null>(null);

  const open = selected !== null;
  const expired = expiresAt !== null && now > 0 && now >= expiresAt;

  // 1-second tick for the signed-link countdown; runs only while a dialog is open.
  React.useEffect(() => {
    if (!open || expiresAt === null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [open, expiresAt]);

  const loadQueue = React.useCallback(async (nextStatus: KycStatusValue) => {
    setListLoading(true);
    setListError(null);
    try {
      const data = await adminRequest<KycReviewRow[]>(
        `/api/v1/admin/kyc?status=${encodeURIComponent(nextStatus)}`,
      );
      setRows(data);
    } catch (error) {
      setListError(errorMessage(error));
      setRows([]);
    } finally {
      setListLoading(false);
    }
  }, []);

  const loadDocuments = React.useCallback(async (profileId: string) => {
    setFilesLoading(true);
    setFilesError(null);
    try {
      const data = await adminRequest<KycDocumentUrlEntry[]>(
        `/api/v1/admin/kyc/${encodeURIComponent(profileId)}/files`,
      );
      setFiles(data);
      // Every entry carries the server's TTL; the shortest one governs the countdown.
      const ttl = data.reduce((min, entry) => Math.min(min, entry.expiresInSeconds || 300), 300);
      setExpiresAt(Date.now() + ttl * 1000);
      setNow(Date.now());
      toast({
        variant: 'info',
        title: 'Signed links issued',
        description: `Valid for ${ttl} seconds. This fetch was recorded as KYC_DOCUMENT_VIEWED against your admin id.`,
      });
    } catch (error) {
      setFiles(null);
      setExpiresAt(null);
      setFilesError(errorMessage(error));
    } finally {
      setFilesLoading(false);
    }
  }, []);

  const openReview = async (row: KycReviewRow) => {
    setSelected(row);
    setDetail(null);
    setDetailError(null);
    setFiles(null);
    setFilesError(null);
    setExpiresAt(null);
    setReason('');
    setDecisionError(null);
    setDetailLoading(true);
    try {
      const profile = await adminRequest<KycDetailView>(
        `/api/v1/admin/kyc/${encodeURIComponent(row.id)}`,
      );
      setDetail(profile);
      await loadDocuments(row.id);
    } catch (error) {
      setDetailError(errorMessage(error));
    } finally {
      setDetailLoading(false);
    }
  };

  const closeReview = () => {
    setSelected(null);
    setDetail(null);
    setDetailError(null);
    setFiles(null);
    setFilesError(null);
    setExpiresAt(null);
    setReason('');
    setDecisionError(null);
  };

  const submitDecision = async (decision: Decision) => {
    if (!selected) return;
    const trimmed = reason.trim();
    if (decision !== 'APPROVE' && trimmed.length < 3) {
      setDecisionError(
        decision === 'REJECT'
          ? 'A rejection reason is required — it is shown to the client and written to the audit log.'
          : 'Describe what additional information the client must provide.',
      );
      return;
    }

    setSubmitting(decision);
    setDecisionError(null);
    try {
      await adminRequest<unknown>(`/api/v1/admin/kyc/${encodeURIComponent(selected.id)}/decision`, {
        method: 'POST',
        body: { decision, rejectionReason: decision === 'APPROVE' ? null : trimmed },
      });
      toast({
        variant: decision === 'APPROVE' ? 'success' : 'warn',
        title:
          decision === 'APPROVE'
            ? 'Submission approved'
            : decision === 'REJECT'
              ? 'Submission rejected'
              : 'Additional information requested',
        description: `${selected.fullName} · ${selected.email}. The decision and its reason were written to the audit log.`,
      });
      closeReview();
      await loadQueue(status);
      router.refresh();
    } catch (error) {
      setDecisionError(errorMessage(error));
    } finally {
      setSubmitting(null);
    }
  };

  const columns = React.useMemo<DataTableColumn<KycReviewRow>[]>(
    () => [
      {
        key: 'applicant',
        header: 'Applicant',
        cell: (row) => (
          <div className="flex flex-col">
            <span className="text-sm text-base-100">{row.fullName}</span>
            <span className="text-xs text-muted">{row.email}</span>
          </div>
        ),
      },
      {
        key: 'country',
        header: 'Country',
        cell: (row) => <span className="text-sm text-muted">{row.country}</span>,
      },
      {
        key: 'legalName',
        header: 'Legal name',
        cell: (row) => <span className="text-sm text-base-100">{row.legalName}</span>,
      },
      {
        key: 'idType',
        header: 'Document',
        cell: (row) => <span className="text-sm text-muted">{idTypeLabel(row.idType)}</span>,
      },
      {
        key: 'submitted',
        header: 'Submitted',
        cell: (row) => (
          <span suppressHydrationWarning className="text-xs tabular-nums text-muted">
            {relativeTime(row.createdAt)}
          </span>
        ),
      },
      {
        key: 'status',
        header: 'Status',
        cell: (row) => <StatusBadge status={row.status} kind="kyc" showIcon />,
      },
      {
        key: 'action',
        header: '',
        align: 'right',
        cell: (row) => (
          <Button
            variant="outline"
            size="sm"
            onClick={(event) => {
              event.stopPropagation();
              void openReview(row);
            }}
          >
            Review
          </Button>
        ),
      },
    ],
    // `openReview` only touches stable setters and a memoised loader.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const documentRows = (detail?.documents ?? []).map((doc) => ({
    kind: doc.kind,
    uploaded: doc.uploaded,
    signed: files?.find((entry) => entry.kind === doc.kind),
  }));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs value={status} onValueChange={(value) => {
          const next = value as KycStatusValue;
          setStatus(next);
          void loadQueue(next);
        }}>
          <TabsList>
            {KYC_STATUS_TABS.map((tab) => (
              <TabsTrigger key={tab.value} value={tab.value}>
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-2">
          {listLoading ? <Spinner size="sm" label="Refreshing queue" /> : null}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void loadQueue(status)}
            disabled={listLoading}
          >
            <RefreshCw aria-hidden className={cn(listLoading && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      </div>

      <p className="text-xs leading-relaxed text-muted">
        Oldest submission first, so no client is starved behind newer files. “Pending” means queued
        for review, “Under review” means a compliance officer has claimed the file.
      </p>

      {listError ? (
        <Alert variant="danger">
          <AlertTitle>Could not load the queue</AlertTitle>
          <AlertDescription>{listError}</AlertDescription>
        </Alert>
      ) : null}

      <DataTable<KycReviewRow>
        columns={columns}
        rows={rows}
        getRowKey={(row) => row.id}
        isLoading={listLoading && rows.length === 0}
        skeletonRows={5}
        onRowClick={(row) => void openReview(row)}
        emptyState={
          <EmptyState
            icon={ShieldCheck}
            title="Nothing in this queue"
            description="No submission currently carries this status. Files appear here the moment a client submits documents for review."
          />
        }
      />

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) closeReview();
        }}
      >
        <DialogContent className="max-h-[92vh] w-[min(96vw,72rem)] max-w-none overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-2">
              {selected?.fullName ?? 'KYC review'}
              {detail ? <StatusBadge status={detail.status} kind="kyc" showIcon /> : null}
            </DialogTitle>
            <DialogDescription>
              {selected
                ? `${selected.email} · ${selected.country} · submitted ${relativeTime(selected.createdAt)}`
                : null}
            </DialogDescription>
          </DialogHeader>

          {detailLoading ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted">
              <Loader2 aria-hidden className="size-4 animate-spin" />
              Loading the declared profile and the signed document links…
            </div>
          ) : null}

          {detailError ? (
            <Alert variant="danger">
              <AlertTitle>Could not open this submission</AlertTitle>
              <AlertDescription>{detailError}</AlertDescription>
            </Alert>
          ) : null}

          {detail ? (
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
              <div className="flex flex-col gap-3">
                <h3 className="text-sm font-semibold text-base-100">
                  Declared profile — compare against the documents
                </h3>
                <dl className="flex flex-col divide-y divide-line/60 rounded-lg border border-line bg-base-900/40">
                  {declaredRows(detail).map((row) => (
                    <div key={row.label} className="flex items-start justify-between gap-4 px-3 py-2">
                      <dt className="text-xs uppercase tracking-wide text-muted">{row.label}</dt>
                      <dd className="max-w-[60%] text-right text-sm text-base-100">
                        {row.value ?? (
                          <span className="text-xs italic text-muted">
                            not returned by the admin detail endpoint
                          </span>
                        )}
                      </dd>
                    </div>
                  ))}
                </dl>

                <Alert variant="warn">
                  <AlertTitle>Compare against the documents</AlertTitle>
                  <AlertDescription>
                    The admin detail endpoint returns the legal name and the ID type. The date of
                    birth, the residential address and the masked ID number are not part of its
                    payload, so those rows stay marked as unavailable and the document images are the
                    record to check them against. Nothing here is inferred: no date, address or number
                    is guessed from the uploaded files.
                  </AlertDescription>
                </Alert>

                <div className="flex flex-col gap-1 text-xs text-muted">
                  {detail.rejectionReason ? (
                    <span className="text-warn-400">
                      Previous review note: {detail.rejectionReason}
                    </span>
                  ) : null}
                  {detail.reviewedAt ? (
                    <span suppressHydrationWarning>
                      Last reviewed {relativeTime(detail.reviewedAt)}
                    </span>
                  ) : (
                    <span>Not reviewed before.</span>
                  )}
                </div>
              </div>

              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-base-100">Documents</h3>
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        'inline-flex items-center gap-1 text-xs tabular-nums',
                        expired ? 'text-loss-400' : 'text-muted',
                      )}
                    >
                      <Clock aria-hidden className="size-3" />
                      {expiresAt === null
                        ? 'no signed links'
                        : expired
                          ? 'links expired'
                          : `expires in ${formatCountdown(expiresAt - now)}`}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={filesLoading}
                      onClick={() => void loadDocuments(detail.id)}
                    >
                      <RefreshCw aria-hidden className={cn(filesLoading && 'animate-spin')} />
                      Refresh links
                    </Button>
                  </div>
                </div>

                <Alert variant="info" icon={ShieldCheck}>
                  <AlertTitle>Document access is logged</AlertTitle>
                  <AlertDescription>
                    Identity documents live in a private bucket and are readable only through
                    short-lived signed links (5 minutes maximum). Every fetch writes a{' '}
                    <code className="font-mono text-xs">KYC_DOCUMENT_VIEWED</code> entry against your
                    admin id, the document kinds returned, the expiry and your IP address. The stored
                    object key is never sent to this page.
                  </AlertDescription>
                </Alert>

                {filesError ? (
                  <Alert variant="warn">
                    <AlertTitle>Documents unavailable</AlertTitle>
                    <AlertDescription>{filesError}</AlertDescription>
                  </Alert>
                ) : null}

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {documentRows.map((doc) => (
                    <DocumentCard
                      key={doc.kind}
                      kind={doc.kind}
                      uploaded={doc.uploaded}
                      entry={doc.signed}
                      expired={expired}
                    />
                  ))}
                </div>
              </div>
            </div>
          ) : null}

          <Separator />

          {canDecide ? (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="kyc-decision-reason">
                  Review reason{' '}
                  <span className="text-xs font-normal text-muted">
                    (required to reject or to request more information)
                  </span>
                </Label>
                <Textarea
                  id="kyc-decision-reason"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="e.g. The proof of address is dated more than 3 months ago — please upload a recent utility bill."
                  rows={3}
                />
              </div>

              {decisionError ? (
                <Alert variant="danger">
                  <AlertTitle>Decision not recorded</AlertTitle>
                  <AlertDescription>{decisionError}</AlertDescription>
                </Alert>
              ) : null}

              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => void submitDecision('REQUEST_MORE_INFO')}
                  disabled={submitting !== null}
                >
                  <MessageSquareWarning aria-hidden />
                  {submitting === 'REQUEST_MORE_INFO' ? 'Requesting…' : 'Request more info'}
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => void submitDecision('REJECT')}
                  disabled={submitting !== null}
                >
                  <Ban aria-hidden />
                  {submitting === 'REJECT' ? 'Rejecting…' : 'Reject'}
                </Button>
                <Button
                  variant="success"
                  onClick={() => void submitDecision('APPROVE')}
                  disabled={submitting !== null}
                >
                  <CircleCheck aria-hidden />
                  {submitting === 'APPROVE' ? 'Approving…' : 'Approve'}
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <Alert variant="warn">
              <AlertTitle>Read-only queue</AlertTitle>
              <AlertDescription>
                Your role can see the review queue but cannot open identity documents or record a
                decision — both are ADMIN-only in the API. Ask an administrator to complete this
                file.
              </AlertDescription>
            </Alert>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default KycReviewer;
