import { ApiError, clientIp, handler, ok, readJson } from '@/lib/http';
import { rateLimit } from '@/lib/rate-limit';
import { contactMessageSchema } from '@/components/public/contact-schema';
import { recordAudit } from '@/server/modules/audit/audit.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/contact
 *
 * Receives a public contact-form submission.
 *
 * What this route is allowed to do:
 *   • validate the payload against the schema shared with the client form
 *     (the same zod object runs in both places, so they cannot drift);
 *   • rate-limit by client IP (public, unauthenticated, write endpoint);
 *   • record the message on the append-only audit log under its own action, and
 *     return the standard envelope.
 *
 * What it deliberately does NOT do:
 *   • It sends no email and claims to have sent none — there is no mail transport
 *     in this platform, and a route that claimed one would be lying to the
 *     sender. Support works from the recorded queue.
 *   • It writes no row to a table that does not exist. The audit log is the
 *     system's existing append-only store for exactly this kind of event.
 *   • It stores the minimum needed to answer: the name and email address to reply
 *     to, the subject, the message itself and the client IP for abuse handling.
 *     Nothing else from the request is persisted.
 */

/** Named so the admin log filter and any future alerting share one string. */
// Not exported: Next.js route files may only export route handlers, config
// fields and a small allow-list — an extra export fails the production build.
const CONTACT_MESSAGE_RECEIVED_ACTION = 'CONTACT_MESSAGE_RECEIVED';

/** Messages per IP per window. */
const CONTACT_RATE_LIMIT = 5;
const CONTACT_RATE_WINDOW_SECONDS = 600;

/** Service target quoted back to the sender, in hours. */
const RESPONSE_TARGET_HOURS = 48;

export const POST = handler(async (request: Request) => {
  const ip = clientIp(request);

  const limit = await rateLimit(
    `contact:ip:${ip ?? 'unknown'}`,
    CONTACT_RATE_LIMIT,
    CONTACT_RATE_WINDOW_SECONDS,
  );
  if (!limit.allowed) {
    throw ApiError.rateLimited(
      `Too many messages from this address. Try again in ${limit.resetSeconds} seconds.`,
    );
  }

  const message = contactMessageSchema.parse(await readJson(request));

  await recordAudit({
    action: CONTACT_MESSAGE_RECEIVED_ACTION,
    ipAddress: ip,
    // `details` is the message minus anything we chose not to keep: no user
    // agent, no cookies, no referrer. Email is kept because a reply needs it.
    details: {
      channel: 'public-contact-form',
      name: message.name,
      email: message.email,
      subject: message.subject,
      subjectLine: message.subjectLine ?? null,
      message: message.message,
      receivedAt: new Date().toISOString(),
    },
  });

  return ok({
    received: true,
    responseTargetHours: RESPONSE_TARGET_HOURS,
    note: 'Your message was recorded against the platform audit log and is queued for review.',
  });
});
