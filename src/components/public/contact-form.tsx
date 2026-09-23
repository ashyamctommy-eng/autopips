'use client';

import * as React from 'react';
import { CircleAlert, Send } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { inputClassName } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  CONTACT_MESSAGE_MAX_LENGTH,
  CONTACT_SUBJECT_LABEL,
  CONTACT_SUBJECTS,
  validateContactMessage,
  type ContactMessageInput,
  type ContactSubject,
} from '@/components/public/contact-schema';

/**
 * Contact form.
 *
 * Client component: it validates with the shared zod schema before sending, so
 * a visitor sees field-level feedback without a round trip, and the same schema
 * runs again on the server. The response is rendered inline (and announced via
 * `role="status"`), and the success copy deliberately says only what happened —
 * the message was recorded. No email is sent by this flow.
 */

interface ContactSuccess {
  received: boolean;
  responseTargetHours: number;
  note: string;
}

interface ContactErrorEnvelope {
  ok: false;
  error: { code: string; message: string };
}

type ContactEnvelope = { ok: true; data: ContactSuccess } | ContactErrorEnvelope;

function isErrorEnvelope(payload: ContactEnvelope): payload is ContactErrorEnvelope {
  return payload.ok === false;
}

interface FormValues {
  name: string;
  email: string;
  subject: ContactSubject | '';
  subjectLine: string;
  message: string;
}

const EMPTY_FORM: FormValues = {
  name: '',
  email: '',
  subject: '',
  subjectLine: '',
  message: '',
};

/** Field errors, keyed by form field. */
type FormErrors = Partial<Record<keyof ContactMessageInput, string>>;

type SubmitState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'success'; data: ContactSuccess }
  | { kind: 'error'; message: string };

export interface ContactFormProps {
  className?: string;
}

export function ContactForm({ className }: ContactFormProps) {
  const [values, setValues] = React.useState<FormValues>(EMPTY_FORM);
  const [errors, setErrors] = React.useState<FormErrors>({});
  const [touched, setTouched] = React.useState<Partial<Record<keyof FormValues, boolean>>>({});
  const [state, setState] = React.useState<SubmitState>({ kind: 'idle' });

  const submitting = state.kind === 'submitting';

  const update = <K extends keyof FormValues>(field: K, value: FormValues[K]) => {
    const next = { ...values, [field]: value };
    setValues(next);
    if (touched[field]) {
      const fieldErrors = validateContactMessage(next).errors;
      const message = fieldErrors ? fieldErrors[field as keyof ContactMessageInput] : undefined;
      setErrors((prev) => ({ ...prev, [field]: message }));
    }
  };

  const blur = (field: keyof FormValues) => {
    setTouched((prev) => ({ ...prev, [field]: true }));
    const fieldErrors = validateContactMessage(values).errors;
    const message = fieldErrors ? fieldErrors[field as keyof ContactMessageInput] : undefined;
    setErrors((prev) => ({ ...prev, [field]: message }));
  };

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setTouched({ name: true, email: true, subject: true, subjectLine: true, message: true });

    const result = validateContactMessage(values);
    if (result.errors) {
      setErrors(result.errors);
      setState({ kind: 'error', message: 'Please correct the highlighted fields and try again.' });
      return;
    }

    setErrors({});
    setState({ kind: 'submitting' });

    try {
      const response = await fetch('/api/v1/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(result.data),
      });

      const payload = (await response.json()) as ContactEnvelope;

      if (!response.ok || isErrorEnvelope(payload)) {
        const message = isErrorEnvelope(payload)
          ? payload.error.message
          : 'The message could not be recorded. Please try again shortly.';
        setState({ kind: 'error', message });
        return;
      }

      setValues(EMPTY_FORM);
      setTouched({});
      setState({ kind: 'success', data: payload.data });
    } catch {
      setState({
        kind: 'error',
        message:
          'We could not reach the server. Check your connection and try again — nothing was sent.',
      });
    }
  };

  const fieldError = (field: keyof FormValues) => (touched[field] ? errors[field] : undefined);

  return (
    <form noValidate onSubmit={onSubmit} className={cn('flex flex-col gap-5', className)}>
      <div aria-live="polite" className="flex flex-col gap-3">
        {state.kind === 'success' ? (
          <Alert variant="success">
            <AlertTitle>Message recorded</AlertTitle>
            <AlertDescription>
              {state.data.note} We aim to reply within {state.data.responseTargetHours} hours on
              business days.
            </AlertDescription>
          </Alert>
        ) : null}

        {state.kind === 'error' ? (
          <Alert variant="danger">
            <AlertTitle>Message not recorded</AlertTitle>
            <AlertDescription>{state.message}</AlertDescription>
          </Alert>
        ) : null}
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          id="contact-name"
          label="Your name"
          error={fieldError('name')}
          hint="So we know who we are replying to."
        >
          <input
            id="contact-name"
            name="name"
            type="text"
            autoComplete="name"
            required
            className={inputClassName}
            value={values.name}
            aria-invalid={fieldError('name') ? true : undefined}
            aria-describedby={fieldError('name') ? 'contact-name-error' : undefined}
            onChange={(event) => update('name', event.target.value)}
            onBlur={() => blur('name')}
          />
        </Field>

        <Field
          id="contact-email"
          label="Email address"
          error={fieldError('email')}
          hint="The only place a reply can reach you."
        >
          <input
            id="contact-email"
            name="email"
            type="email"
            autoComplete="email"
            required
            className={inputClassName}
            value={values.email}
            aria-invalid={fieldError('email') ? true : undefined}
            aria-describedby={fieldError('email') ? 'contact-email-error' : undefined}
            onChange={(event) => update('email', event.target.value)}
            onBlur={() => blur('email')}
          />
        </Field>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field id="contact-subject" label="Subject" error={fieldError('subject')} required>
          <select
            id="contact-subject"
            name="subject"
            required
            className={cn(inputClassName, 'pr-8')}
            value={values.subject}
            aria-invalid={fieldError('subject') ? true : undefined}
            aria-describedby={fieldError('subject') ? 'contact-subject-error' : undefined}
            onChange={(event) => update('subject', event.target.value as ContactSubject | '')}
            onBlur={() => blur('subject')}
          >
            <option value="">Choose a subject</option>
            {CONTACT_SUBJECTS.map((subject) => (
              <option key={subject} value={subject}>
                {CONTACT_SUBJECT_LABEL[subject]}
              </option>
            ))}
          </select>
        </Field>

        <Field
          id="contact-subject-line"
          label="Subject detail (optional)"
          error={fieldError('subjectLine')}
        >
          <input
            id="contact-subject-line"
            name="subjectLine"
            type="text"
            className={inputClassName}
            value={values.subjectLine}
            onChange={(event) => update('subjectLine', event.target.value)}
            onBlur={() => blur('subjectLine')}
          />
        </Field>
      </div>

      <Field
        id="contact-message"
        label="Message"
        error={fieldError('message')}
        hint={`Up to ${CONTACT_MESSAGE_MAX_LENGTH} characters. Never send passwords, seed phrases or private keys.`}
        required
      >
        <Textarea
          id="contact-message"
          name="message"
          required
          rows={8}
          maxLength={CONTACT_MESSAGE_MAX_LENGTH}
          value={values.message}
          aria-invalid={fieldError('message') ? true : undefined}
          aria-describedby={fieldError('message') ? 'contact-message-error' : 'contact-message-hint'}
          onChange={(event) => update('message', event.target.value)}
          onBlur={() => blur('message')}
        />
      </Field>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-md text-xs leading-relaxed text-muted">
          Submitting records your message and the details you enter against the platform&rsquo;s
          audit log. No email is sent by this form.
        </p>
        <Button type="submit" variant="primary" disabled={submitting}>
          {submitting ? (
            'Recording…'
          ) : (
            <>
              <Send aria-hidden />
              Send message
            </>
          )}
        </Button>
      </div>
    </form>
  );
}

interface FieldProps {
  id: string;
  label: string;
  error?: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}

function Field({ id, label, error, hint, required = false, children }: FieldProps) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>
        {label}
        {required ? (
          <span className="ml-1 text-muted" aria-hidden>
            *
          </span>
        ) : null}
      </Label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="flex items-center gap-1 text-xs text-loss-400">
          <CircleAlert aria-hidden className="size-3" />
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs leading-relaxed text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
