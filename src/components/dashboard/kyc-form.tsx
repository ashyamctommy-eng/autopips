'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { CircleCheck, FileUp, Info, ShieldCheck } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
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
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/use-toast';
import { cn } from '@/lib/utils';
import type { KycProfileDTO } from '@/types/api';
import { apiFetch } from '@/lib/session-refresh';

/**
 * Manual KYC submission form (client component).
 *
 * Flow (business directive #5 — a human reviewer makes the decision):
 *   1. the browser validates the type and size of every file,
 *   2. each file is streamed to `POST /api/v1/kyc/upload` (multipart), which
 *      encrypts it and stores it inside the platform, returning opaque document
 *      row ids,
 *   3. those ids plus the personal details go to `POST /api/v1/kyc/submit`.
 *
 * The server's answer is always the authority: this component mirrors the
 * upload allow-list for fast feedback, and surfaces the API's own error message
 * (including Zod issue details) when the server rejects something the mirror let
 * through.
 *
 * This component NEVER previews a document. There is no thumbnail and no
 * filename round-trip: a reviewer opens a file through an internal, audited
 * admin-only route, and nothing that grants access to the bytes reaches this
 * client.
 */

/** Mirror of KYC_ALLOWED_CONTENT_TYPES (src/server/modules/kyc/storage.service.ts). */
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;
const ACCEPT_ATTRIBUTE = ALLOWED_TYPES.join(',');
/** Mirror of KYC_MAX_DOCUMENT_BYTES. */
const MAX_BYTES = 10 * 1024 * 1024;
const MIN_AGE_YEARS = 18;

const ID_TYPES = [
  { value: 'PASSPORT', label: 'Passport' },
  { value: 'NATIONAL_ID', label: 'National ID card' },
  { value: 'DRIVERS_LICENSE', label: 'Driving licence' },
] as const;

type DocumentField = 'idFront' | 'idBack';

/** The `POST /api/v1/kyc/upload` response: row ids, never storage keys. */
interface UploadKeys {
  idFrontDocumentId: string;
  idBackDocumentId: string | null;
  /** Slots the account holds after this write; informational. */
  storedKinds: string[];
}

export interface KycFormProps {
  /** Existing profile, when one has been submitted before. */
  initial: KycProfileDTO | null;
}

interface FieldErrors {
  legalName?: string;
  dob?: string;
  address?: string;
  idType?: string;
  idNumber?: string;
  idFront?: string;
  idBack?: string;
}

function describeFile(file: File): string {
  const kb = file.size / 1024;
  const size = kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.round(kb)} KB`;
  return `${file.name} · ${size}`;
}

function validateFile(file: File): string | null {
  const type = file.type.toLowerCase();
  if (!(ALLOWED_TYPES as readonly string[]).includes(type)) {
    return 'Only JPEG, PNG, WebP or PDF files are accepted.';
  }
  if (file.size === 0) return 'That file is empty.';
  if (file.size > MAX_BYTES) return `Files may not exceed ${MAX_BYTES / (1024 * 1024)} MB.`;
  return null;
}

/** Parse a strict YYYY-MM-DD date, mirroring the server's parseIsoDateOnly. */
function parseIsoDateOnly(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(date.getTime())) return null;
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

function ageInYears(dob: Date, now: Date = new Date()): number {
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const monthDelta = now.getUTCMonth() - dob.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < dob.getUTCDate())) age -= 1;
  return age;
}

/** Server envelope → message (+ Zod issue details when the API sent them). */
function serverError(body: unknown, fallback: string): string {
  if (typeof body !== 'object' || body === null) return fallback;
  const envelope = body as { ok?: unknown; error?: unknown };
  if (envelope.ok !== false) return fallback;
  const error = envelope.error as { message?: unknown; details?: unknown } | null | undefined;
  const message = typeof error?.message === 'string' ? error.message : fallback;
  const issues: string[] = [];
  if (Array.isArray(error?.details)) {
    for (const detail of error.details) {
      if (typeof detail === 'object' && detail !== null) {
        const entry = detail as { path?: unknown; message?: unknown };
        if (typeof entry.message === 'string') {
          issues.push(typeof entry.path === 'string' && entry.path ? `${entry.path}: ${entry.message}` : entry.message);
        }
      }
    }
  }
  return issues.length > 0 ? `${message} ${issues.join(' • ')}` : message;
}

function isUploadKeys(value: unknown): value is UploadKeys {
  if (typeof value !== 'object' || value === null) return false;
  const keys = value as Record<string, unknown>;
  // `storedKinds` is informational, so a payload that omits it (or a future one
  // that reshapes it) still passes as long as the two ids we submit are sound.
  const storedKinds = keys.storedKinds;
  return (
    typeof keys.idFrontDocumentId === 'string' &&
    (keys.idBackDocumentId === null || typeof keys.idBackDocumentId === 'string') &&
    (storedKinds === undefined || Array.isArray(storedKinds))
  );
}

const STEP_LABELS = ['Personal details', 'Identity documents'] as const;

export function KycForm({ initial }: KycFormProps) {
  const router = useRouter();

  const [step, setStep] = React.useState(0);
  const [legalName, setLegalName] = React.useState(initial?.legalName ?? '');
  const [dob, setDob] = React.useState('');
  const [address, setAddress] = React.useState(initial?.address ?? '');
  const [idType, setIdType] = React.useState<string>('PASSPORT');
  const [idNumber, setIdNumber] = React.useState('');
  const [files, setFiles] = React.useState<Record<DocumentField, File | null>>({
    idFront: null,
    idBack: null,
  });
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const [serverMessage, setServerMessage] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  // Server rule (submitKycSchema.superRefine): only a passport is reliably
  // single-sided; a national ID card or driving licence carries data on the
  // reverse and must have its back uploaded.
  const idBackRequired = idType !== 'PASSPORT';
  const idBackNoun = idType === 'DRIVERS_LICENSE' ? 'driving licence' : 'national ID card';
  const onFileField = onFileFieldFactory(setFiles, setErrors);

  const validateStep = (target: number): FieldErrors => {
    const next: FieldErrors = {};
    if (target >= 0) {
      if (legalName.trim().length < 2) next.legalName = 'Enter your full legal name.';
      const parsed = parseIsoDateOnly(dob);
      if (!dob.trim()) next.dob = 'Date of birth is required.';
      else if (!parsed) next.dob = 'Use the date picker (YYYY-MM-DD).';
      else if (parsed.getTime() > Date.now()) next.dob = 'Date of birth must be in the past.';
      else if (ageInYears(parsed) < MIN_AGE_YEARS) {
        next.dob = `You must be at least ${MIN_AGE_YEARS} years old to open an account.`;
      }
      if (address.trim().length < 5) next.address = 'Enter your residential address.';
    }
    if (target >= 1) {
      if (!ID_TYPES.some((entry) => entry.value === idType)) next.idType = 'Choose a document type.';
      if (idNumber.trim().length < 3) next.idNumber = 'Enter the document number.';
      if (!files.idFront) next.idFront = 'Upload the front of your identity document.';
      else {
        const problem = validateFile(files.idFront);
        if (problem) next.idFront = problem;
      }
      if (idBackRequired) {
        if (!files.idBack) next.idBack = `The reverse side of a ${idBackNoun} is required.`;
        else {
          const problem = validateFile(files.idBack);
          if (problem) next.idBack = problem;
        }
      } else if (files.idBack) {
        const problem = validateFile(files.idBack);
        if (problem) next.idBack = problem;
      }
    }
    return next;
  };

  const goNext = () => {
    const found = validateStep(step);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setStep((current) => Math.min(current + 1, STEP_LABELS.length - 1));
  };

  const goBack = () => {
    setErrors({});
    setServerMessage(null);
    setStep((current) => Math.max(current - 1, 0));
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const found = validateStep(1);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      // Send the user to the first step that has a problem, so the message is
      // always next to the field it belongs to.
      if (found.legalName || found.dob || found.address) setStep(0);
      else setStep(1);
      return;
    }
    if (!files.idFront) return;

    setSubmitting(true);
    setServerMessage(null);
    try {
      const form = new FormData();
      form.append('idFront', files.idFront);
      if (files.idBack) form.append('idBack', files.idBack);

      const uploadResponse = await apiFetch('/api/v1/kyc/upload', {
        method: 'POST',
        body: form,
        credentials: 'include',
        headers: { accept: 'application/json' },
      });
      const uploadBody: unknown = await uploadResponse.json();
      const uploadData =
        typeof uploadBody === 'object' && uploadBody !== null
          ? (uploadBody as { ok?: unknown; data?: unknown })
          : null;
      if (!uploadResponse.ok || uploadData?.ok !== true || !isUploadKeys(uploadData.data)) {
        const message = serverError(
          uploadBody,
          `The document upload failed (HTTP ${uploadResponse.status}).`,
        );
        setServerMessage(message);
        toast({ title: 'Upload failed', description: message, variant: 'danger' });
        return;
      }

      const keys = uploadData.data;
      const submitResponse = await apiFetch('/api/v1/kyc/submit', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          legalName: legalName.trim(),
          dob: dob.trim(),
          address: address.trim(),
          idType,
          idNumber: idNumber.trim(),
          idFrontDocumentId: keys.idFrontDocumentId,
          // The upload reports what is on file after the write, so a back side
          // stored by an earlier upload is carried through even when this request
          // did not include one.
          ...(keys.idBackDocumentId ? { idBackDocumentId: keys.idBackDocumentId } : {}),
        }),
      });
      const submitBody: unknown = await submitResponse.json();
      const submitOk =
        typeof submitBody === 'object' &&
        submitBody !== null &&
        (submitBody as { ok?: unknown }).ok === true;

      if (!submitResponse.ok || !submitOk) {
        const message = serverError(
          submitBody,
          `Your submission was rejected (HTTP ${submitResponse.status}).`,
        );
        setServerMessage(message);
        toast({ title: 'Submission not accepted', description: message, variant: 'danger' });
        return;
      }

      toast({
        title: 'Documents submitted',
        description: 'A compliance officer will review your file. You can track the status here.',
        variant: 'success',
      });
      setFiles({ idFront: null, idBack: null });
      setIdNumber('');
      router.refresh();
    } catch {
      const message = 'The submission could not be sent. Check your connection and try again.';
      setServerMessage(message);
      toast({ title: 'Submission failed', description: message, variant: 'danger' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="flex flex-col gap-5" onSubmit={handleSubmit} noValidate>
      <ol className="flex flex-wrap items-center gap-3 text-xs">
        {STEP_LABELS.map((label, index) => {
          const state = index === step ? 'current' : index < step ? 'done' : 'todo';
          return (
            <li key={label} className="flex items-center gap-2">
              <span
                aria-hidden
                className={cn(
                  'inline-flex size-5 items-center justify-center rounded-full border text-[0.65rem]',
                  state === 'current' && 'border-brand/50 bg-brand/15 text-brand-300',
                  state === 'done' && 'border-profit/40 bg-profit/10 text-profit-400',
                  state === 'todo' && 'border-line bg-base-800 text-muted',
                )}
              >
                {state === 'done' ? <CircleCheck className="size-3" /> : index + 1}
              </span>
              <span className={state === 'current' ? 'text-base-100' : 'text-muted'}>{label}</span>
              {index < STEP_LABELS.length - 1 ? <span className="text-muted/50">·</span> : null}
            </li>
          );
        })}
      </ol>

      {serverMessage ? (
        <Alert variant="danger">
          <AlertTitle>Something needs attention</AlertTitle>
          <AlertDescription>{serverMessage}</AlertDescription>
        </Alert>
      ) : null}

      {step === 0 ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label htmlFor="kyc-legal-name">Full legal name</Label>
            <Input
              id="kyc-legal-name"
              name="legalName"
              autoComplete="name"
              value={legalName}
              onChange={(event) => setLegalName(event.target.value)}
              aria-invalid={Boolean(errors.legalName)}
              aria-describedby={errors.legalName ? 'kyc-legal-name-error' : undefined}
              placeholder="Exactly as printed on your identity document"
            />
            <FieldError id="kyc-legal-name-error" message={errors.legalName} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="kyc-dob">Date of birth</Label>
            <Input
              id="kyc-dob"
              name="dob"
              type="date"
              value={dob}
              onChange={(event) => setDob(event.target.value)}
              aria-invalid={Boolean(errors.dob)}
              aria-describedby={errors.dob ? 'kyc-dob-error' : undefined}
            />
            <FieldError id="kyc-dob-error" message={errors.dob} />
          </div>

          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label htmlFor="kyc-address">Residential address</Label>
            <Textarea
              id="kyc-address"
              name="address"
              rows={3}
              autoComplete="street-address"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              aria-invalid={Boolean(errors.address)}
              aria-describedby={errors.address ? 'kyc-address-error' : undefined}
              placeholder="Street, city, postal code, country"
            />
            <FieldError id="kyc-address-error" message={errors.address} />
          </div>
        </div>
      ) : null}

      {step === 1 ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="kyc-id-type">Document type</Label>
            <Select value={idType} onValueChange={setIdType}>
              <SelectTrigger id="kyc-id-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ID_TYPES.map((entry) => (
                  <SelectItem key={entry.value} value={entry.value}>
                    {entry.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldError id="kyc-id-type-error" message={errors.idType} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="kyc-id-number">Document number</Label>
            <Input
              id="kyc-id-number"
              name="idNumber"
              value={idNumber}
              onChange={(event) => setIdNumber(event.target.value)}
              aria-invalid={Boolean(errors.idNumber)}
              aria-describedby={errors.idNumber ? 'kyc-id-number-error' : undefined}
              placeholder={initial ? `Currently on file: ${initial.idNumberMasked}` : 'Document number'}
            />
            <FieldError id="kyc-id-number-error" message={errors.idNumber} />
          </div>

          <FileField
            id="kyc-id-front"
            label="Identity document — front"
            hint={initial?.documents.find((doc) => doc.kind === 'idFront')?.uploaded ? 'A document is already on file; uploading a new one replaces it.' : 'Photo or scan of the front page.'}
            file={files.idFront}
            error={errors.idFront}
            onChange={onFileField('idFront')}
            required
          />

          <FileField
            id="kyc-id-back"
            label={idBackRequired ? 'Identity document — back (required)' : 'Identity document — back (optional)'}
            hint={
              idBackRequired
                ? `A ${idBackNoun} carries data on the reverse, so the back is required.`
                : 'A passport is single-sided, so the back is optional. National ID cards and driving licences carry data on the reverse, so they must include it.'
            }
            file={files.idBack}
            error={errors.idBack}
            onChange={onFileField('idBack')}
            required={idBackRequired}
          />
        </div>
      ) : null}

      <Separator />

      <div className="flex flex-col gap-3">
        <p className="flex items-start gap-2 text-xs leading-relaxed text-muted">
          <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          Documents are encrypted and stored by the platform itself, and are opened only by a
          compliance officer through an internal, audited admin-only route. No document is ever
          previewed to you.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {step > 0 ? (
            <Button type="button" variant="ghost" onClick={goBack} disabled={submitting}>
              Back
            </Button>
          ) : null}
          {step < STEP_LABELS.length - 1 ? (
            <Button type="button" variant="primary" onClick={goNext}>
              Continue
            </Button>
          ) : (
            <Button type="submit" variant="primary" disabled={submitting}>
              {submitting ? <Spinner size="sm" label="Submitting" /> : <ShieldCheck aria-hidden />}
              Submit for review
            </Button>
          )}
        </div>
      </div>
    </form>
  );
}

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="text-xs text-loss-400">
      {message}
    </p>
  );
}

interface FileFieldProps {
  id: string;
  label: string;
  hint: string;
  file: File | null;
  error?: string;
  onChange: (file: File | null) => void;
  required: boolean;
}

function FileField({ id, label, hint, file, error, onChange, required }: FileFieldProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>
        {label}
        {required ? <span className="text-loss-400"> *</span> : null}
      </Label>
      <Input
        id={id}
        name={id}
        type="file"
        accept={ACCEPT_ATTRIBUTE}
        className="h-auto py-1.5 text-xs file:mr-3 file:rounded file:bg-base-700 file:px-2 file:py-1 file:text-xs"
        onChange={(event) => onChange(event.target.files?.[0] ?? null)}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-error` : `${id}-hint`}
      />
      <p id={`${id}-hint`} className="text-xs leading-relaxed text-muted">
        {hint}
      </p>
      {file ? (
        <p className="flex items-center gap-1.5 text-xs text-brand-300">
          <FileUp aria-hidden className="size-3.5" />
          {describeFile(file)}
        </p>
      ) : null}
      <FieldError id={`${id}-error`} message={error} />
    </div>
  );
}

/** One handler per slot, so the file map stays typed without `any`. */
function onFileFieldFactory(
  setFiles: React.Dispatch<React.SetStateAction<Record<DocumentField, File | null>>>,
  setErrors: React.Dispatch<React.SetStateAction<FieldErrors>>,
) {
  return (field: DocumentField) => (file: File | null) => {
    const problem = file ? validateFile(file) : null;
    setFiles((previous) => ({ ...previous, [field]: problem ? null : file }));
    setErrors((previous) => ({ ...previous, [field]: problem ?? undefined }));
  };
}

export default KycForm;
