import { ApiError, clientIp, handler, ok } from '@/lib/http';
import { rateLimit } from '@/lib/rate-limit';
import { handleIpn } from '@/server/modules/payments/payments.service';
import { IPN_SIGNATURE_HEADER } from '@/server/modules/payments/ipn.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** NOWPayments caps the IPN body at a small JSON object; refuse anything huge
 *  before it reaches the HMAC/JSON parser. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * POST /api/v1/payments/nowpayments/ipn
 *
 * INTENTIONALLY UNAUTHENTICATED — the HMAC signature IS the authentication:
 * the body is accepted only when `x-nowpayments-sig` is a valid
 * HMAC-SHA512(canonical body, NOWPAYMENTS_IPN_SECRET).
 *
 * The RAW body text is what gets verified. `await request.json()` would
 * re-serialise the payload (key order, number formatting, unicode escapes), the
 * digest would no longer match, and *every* genuine IPN would be rejected —
 * i.e. no deposit would ever be credited again. So: `request.text()` only.
 */
export const POST = handler(async (request: Request) => {
  const ip = clientIp(request);

  // Bound the blast radius of a flood from one source. Generous enough that a
  // legitimate provider retry burst is never dropped. `onInfraFailure: 'allow'`
  // is deliberate: the HMAC below is the authentication, and a 429 while Redis
  // is down would make the provider stop delivering a deposit callback the
  // platform still owes the client.
  const limit = await rateLimit(`ipn:${ip ?? 'unknown'}`, 120, 60, {
    onInfraFailure: 'allow',
  });
  if (!limit.allowed) throw ApiError.rateLimited('Too many IPN deliveries.');

  const rawBody = await request.text();
  if (rawBody.length === 0) throw ApiError.badRequest('Empty IPN body.');
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) {
    throw ApiError.badRequest('IPN body too large.');
  }

  const signature = request.headers.get(IPN_SIGNATURE_HEADER);

  // Verifies first, then reconciles. An invalid signature throws
  // ApiError.unauthorized (401) after an audit row — no deposit or withdrawal is
  // touched. Once the HMAC passes, the body's SHAPE decides where it is routed:
  // a deposit (payment_id) credits equity, a payout (id + withdrawals[]) is
  // matched to a withdrawal by its unique_external_id, and a signature-valid
  // body of neither shape is recorded and ACKed (2xx) rather than answered with
  // a 400 that would make the provider retry it forever.
  await handleIpn({ rawBody, signature, ip });

  // ACK shape NOWPayments expects. Returning 200 for a duplicate delivery is
  // deliberate: the replay guard already made it a no-op.
  return ok({ received: true });
});
