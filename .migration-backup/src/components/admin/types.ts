import type { KycStatusValue } from '@/types/api';

/**
 * Client-side mirrors of the server payloads the admin widgets receive.
 *
 * These are declared locally (instead of `import type` from `src/server/**`) so
 * a client component never reaches into a server module — not even for a type.
 * Each shape is copied from the service that produces it; the comment names the
 * source of truth so drift is easy to spot.
 */

/** `Role` — src/server/modules/admin/admin.service.ts (ADMIN_USER_ROLES). */
export type StaffRole = 'CLIENT' | 'ADMIN' | 'TRADING_MANAGER';

/** `AdminUserRow` — admin.service.ts listUsers()/getAdminUser(). */
export interface AdminUserRowView {
  id: string;
  email: string;
  fullName: string;
  country: string;
  role: StaffRole;
  kycStatus: KycStatusValue;
  is2FAEnabled: boolean;
  createdAt: string;
  capitalUsd: number;
  equity: number;
}

/** `KycDetailClientView` — kyc.service.ts toKycDetailClientView() (metadata only). */
export interface KycDetailView {
  id: string;
  userId: string;
  email: string;
  fullName: string;
  country: string;
  legalName: string;
  idType: string;
  status: KycStatusValue;
  rejectionReason: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
  /**
   * Slot metadata only. The bytes live encrypted in the platform's own Postgres
   * and are reached exclusively through the ADMIN-only, audited stream route
   * named by `KycDocumentEntry.url`; there is no storage key in this payload and
   * there never was one.
   */
  documents: {
    kind: string;
    uploaded: boolean;
    contentType: string | null;
    byteLength: number | null;
    sha256: string | null;
    uploadedAt: string | null;
  }[];
  /**
   * NOT part of the current `KycDetailClientView` payload: `getKycDetail()`
   * returns the legal name and ID type but not the date of birth, the address or
   * the masked ID number. They are declared optional so the dialog renders them
   * the moment the API adds them, and says plainly that they are unavailable
   * until then — a reviewer is never shown a blank that looks like a client error.
   */
  dob?: string;
  address?: string;
  idNumberMasked?: string;
}

/** `KycDocumentEntry` — kyc.service.ts getKycDocumentManifest(). */
export interface KycDocumentEntry {
  kind: string;
  uploaded: boolean;
  contentType: string | null;
  byteLength: number | null;
  sha256: string | null;
  uploadedAt: string | null;
  /**
   * Same-origin, ADMIN-authenticated stream route (no expiry, no signature), or
   * null for an empty slot. There is nothing here that works outside a
   * signed-in admin session.
   */
  url: string | null;
}

/** `SyncSummary` — broker.sync.ts. */
export interface SyncSummaryView {
  positions: number;
  deals: number;
  unattributed: number;
  errors: number;
  investmentsUpdated: number;
}

/** GET /api/v1/admin/brokers/:id/status */
export interface BrokerProbeResult {
  id: string;
  latencyMs: number | null;
  status: string;
}

/** POST /api/v1/admin/brokers/:id/status */
export interface BrokerSyncResult {
  connectionId: string;
  summary: SyncSummaryView;
}

/** DELETE /api/v1/admin/brokers/:id */
export interface BrokerRemovalResult {
  removed: boolean;
  id: string;
  derivAccountId: string;
}

/** `AuditLog` row joined with its actor — src/server/modules/audit/audit.service.ts. */
export interface AuditLogRowView {
  id: string;
  action: string;
  userId: string | null;
  userEmail: string | null;
  userFullName: string | null;
  ipAddress: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

/** `WithdrawalDTO` plus the client identifier the payout queue needs. */
export interface WithdrawalRowView {
  id: string;
  amountUsd: number;
  cryptoCurrency: string;
  payoutAddress: string;
  feeUsd: number;
  status: string;
  txHash: string | null;
  createdAt: string;
  /** Joined server-side for display. Null when the row has no resolvable user. */
  userEmail: string | null;
}

/**
 * Human labels for the two KYC document slots (`KYC_DOCUMENT_KINDS`) — the front
 * and back of one identity document. The platform stores both itself, encrypted
 * at rest, so neither label refers to an external object store.
 */
export const KYC_DOCUMENT_LABELS: Record<string, string> = {
  idFront: 'ID document — front',
  idBack: 'ID document — back',
};

/** Human labels for `KYC_ID_TYPES`. */
export const KYC_ID_TYPE_LABELS: Record<string, string> = {
  PASSPORT: 'Passport',
  NATIONAL_ID: 'National ID',
  DRIVERS_LICENSE: 'Driver’s licence',
};

export const KYC_STATUS_TABS: { value: KycStatusValue; label: string }[] = [
  { value: 'PENDING', label: 'Pending' },
  { value: 'UNDER_REVIEW', label: 'Under review' },
  { value: 'ADDITIONAL_INFO_REQUIRED', label: 'Additional info' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'REJECTED', label: 'Rejected' },
];

/** Age in whole years from a `YYYY-MM-DD` string; null when unparseable. */
export function ageFromIsoDate(dob: string, now: Date = new Date()): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  let age = now.getUTCFullYear() - year;
  const monthDelta = now.getUTCMonth() - (month - 1);
  if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < day)) age -= 1;
  return age < 0 ? null : age;
}
