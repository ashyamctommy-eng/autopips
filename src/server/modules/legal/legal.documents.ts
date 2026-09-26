import { createHash } from 'node:crypto';

/**
 * Legal documents — the PURE registry (no database, no Prisma).
 *
 * Kept separate from `legal.service.ts` on purpose: the public `/terms`,
 * `/privacy` and `/risk` pages render from this module, and a page must not pull
 * a database client into its module graph (it would make a static page depend on
 * the Prisma singleton). The service module owns publishing and consent capture.
 *
 * A revision is a new `version` string, never an edit to an existing one, so a
 * consent recorded against v1 can always be read back as exactly what the client
 * saw. `contentHash` (SHA-256 of the exact served text) is what makes the record
 * verifiable rather than merely declarative.
 *
 * OPERATOR ACTION: the bodies below are an accurate baseline written from what
 * the platform actually does, but they are NOT a substitute for advice. Have
 * them reviewed by counsel for every jurisdiction you accept clients from, then
 * bump `version` when you publish the reviewed text.
 */

export type LegalDocumentTypeValue = 'TERMS_OF_SERVICE' | 'PRIVACY_POLICY' | 'RISK_DISCLOSURE';

export interface LegalDocumentDefinition {
  type: LegalDocumentTypeValue;
  /** Monotonic revision label. Bump this on ANY published change. */
  version: string;
  title: string;
  /** Canonical public path. */
  url: string;
  /** ISO date the revision took effect. */
  effectiveFrom: string;
  paragraphs: readonly string[];
}

const VERSION = '2026-09-26';

export const CURRENT_LEGAL_DOCUMENTS: readonly LegalDocumentDefinition[] = [
  {
    type: 'TERMS_OF_SERVICE',
    version: VERSION,
    title: 'Terms of Service',
    url: '/terms',
    effectiveFrom: '2026-09-26',
    paragraphs: [
      'These terms govern your use of the Autopipsz managed trading platform. By creating an account you accept them, together with the Privacy Policy and the Risk Disclosure.',
      'Eligibility. You must be at least 18 years old and legally able to enter into a contract in your jurisdiction. You are responsible for complying with the laws that apply to you. The platform makes no claim to be licensed, authorised or registered in any jurisdiction, and it is your responsibility to determine whether using it is lawful where you are.',
      'Your account. You must provide accurate information, keep your credentials and any two-factor device secure, and tell us promptly if you believe your account has been compromised. You are responsible for activity carried out through your account.',
      'Managed trading. You allocate capital to a strategy plan. A master broker account operated by the platform executes the strategy, and resulting profit or loss is attributed to your investment under the plan terms shown in the client area. Allocation is not discretionary advice to you and no strategy is a personal recommendation.',
      'No guarantee. Target returns shown for a plan are objectives, not promises. They are indicative and non-guaranteed. Trading can lose money, including all of the capital you allocate. Past performance does not indicate future results.',
      'Deposits and withdrawals. Deposits are credited only when the payment provider confirms them, and withdrawals are paid only after review and, where required, a second approval. We may refuse or reverse a transaction where we reasonably suspect fraud, error or a legal obligation to do so. Withdrawal payout addresses are subject to an operator allow-list, and a per-day cap may apply.',
      'Identity verification. You must complete identity verification before depositing, allocating capital or withdrawing. Documents are stored encrypted and are reviewed by an authorised administrator. We may decline or terminate a relationship where verification cannot be completed.',
      'Fees. Fees that apply to a plan are shown in the plan terms. Fee changes apply to new investments; existing investments keep the terms they were opened under.',
      'Suspension and termination. We may suspend or terminate access where these terms are breached, where required by law, or to protect the platform or other clients. You may stop using the service at any time; obligations that have already arisen survive termination.',
      'Limitation of liability. To the extent permitted by law, the platform is not liable for indirect or consequential loss, or for loss arising from market movements, from a broker or payment provider failing, or from events beyond its reasonable control. Nothing in these terms excludes liability that cannot lawfully be excluded.',
      'Changes. These terms may be revised. A revision has a new version, and material changes may require you to accept the new version before continuing to use the service.',
      'Contact. Compliance and support enquiries: compliance@autopips.pro and support@autopips.pro.',
    ],
  },
  {
    type: 'PRIVACY_POLICY',
    version: VERSION,
    title: 'Privacy Policy',
    url: '/privacy',
    effectiveFrom: '2026-09-26',
    paragraphs: [
      'This policy explains what personal data Autopipsz collects, why, how long it is kept and who it is shared with.',
      'What we collect. Account data (name, email, phone, country); identity-verification data (legal name, date of birth, address, identity document type and number, and images of your identity document); transaction data (deposits, withdrawals, investments and trades); and security data (IP address, browser user-agent, session and authentication records, and consent records).',
      'Why we collect it. To create and operate your account; to verify identity and meet anti-financial-crime obligations; to process deposits, allocations and withdrawals; to operate and secure the platform; to keep an audit record of decisions that affect money; and to prove which legal documents you accepted.',
      'Identity documents. Identity documents are stored INSIDE the platform, encrypted at rest with AES-256-GCM, in the platform’s own database. They are not sent to a third-party verification provider and there is no external object storage. They are readable only by a signed-in administrator through an audited route that records who viewed a document and when.',
      'Legal basis and consent. We process data to perform our contract with you, to comply with legal obligations, for our legitimate interest in operating a secure platform, and — for consent records themselves — on the basis of the acceptance you give. You can withdraw consent to non-essential processing, though this may mean we can no longer provide the service.',
      'Who we share with. We share only what is necessary with service providers that make the platform work: the broker (to execute trades on the master account) and the crypto payment provider (to create deposit addresses, broadcast payouts and confirm transactions). We do not sell personal data. We may disclose data where legally required.',
      'Retention. Account and consent records are kept while your account is open and afterwards for as long as law or dispute needs require. Transaction and audit records are retained to maintain the integrity of the ledger. Identity documents are removed when they are no longer needed for verification or legal obligations.',
      'Your rights. Depending on where you live, you may have the right to access, correct, delete or restrict processing of your personal data, to object to processing, and to receive a copy of data you provided. Use the contact addresses below. You may also complain to your local data-protection authority.',
      'Cookies and sessions. The platform uses strictly necessary cookies to keep you signed in and to protect against cross-site request forgery. There is no advertising tracking on the client area.',
      'Security. Passwords are hashed with Argon2id. Two-factor authentication is available. Documents are encrypted at rest. Access to production systems is restricted and audited.',
      'Changes and contact. This policy may be revised; a revision has a new version. Privacy enquiries: compliance@autopips.pro.',
    ],
  },
  {
    type: 'RISK_DISCLOSURE',
    version: VERSION,
    title: 'Risk Disclosure',
    url: '/risk',
    effectiveFrom: '2026-09-26',
    paragraphs: [
      'This disclosure summarises the principal risks of using Autopipsz. It is not exhaustive and it is not investment advice. Read it before allocating capital.',
      'Capital at risk. Trading involves substantial risk of loss. You can lose some or all of the capital you allocate. Only allocate money you can afford to lose. Targets shown for a strategy are objectives, not guarantees.',
      'Leverage and multipliers. The broker’s products may use leverage or contract multipliers. These magnify both gains and losses, and a position can lose more than the amount initially committed in adverse conditions.',
      'Managed strategy risk. A master account executes the strategy on your behalf. Allocation decisions and execution are made by the platform’s systems and operators, and may not match any particular client’s preference or time horizon. There is no capital protection and no guaranteed return.',
      'Broker and counterparty risk. Trades are executed through a third-party broker. If the broker fails, becomes insolvent, restricts withdrawals, or changes its terms, the platform may be unable to trade or to return capital promptly. Autopipsz is not a custodian and does not offer legal segregation of client funds.',
      'Payment and settlement risk. Deposits and withdrawals settle in crypto assets through a third-party payment provider. Network congestion, exchange-rate movement between quote and settlement, provider outages, and irreversible blockchain transfers can delay or reduce the amount that arrives. A payout address you supply is your responsibility; transfers to a wrong or unsupported address may be unrecoverable.',
      'Technology and operational risk. The platform depends on software, networks, datastores and third-party APIs. Outages, bugs, misconfiguration and cyber-attacks can interrupt trading, delay payments or corrupt data. The platform keeps an append-only audit record and reconciles the broker against its ledger, but it cannot eliminate these risks.',
      'Liquidity risk. You may not be able to withdraw capital immediately: capital deployed in an active strategy is not withdrawable until it is released, and withdrawals are subject to review, a payout allow-list and a daily cap.',
      'Regulatory risk. Autopipsz makes no claim to be licensed or authorised in any jurisdiction. Regulatory treatment of crypto assets and managed trading changes frequently and may affect your ability to use the service.',
      'No advice. Nothing on the platform is investment, tax or legal advice, and no strategy is a personal recommendation. Decisions you take are your own.',
    ],
  },
] as const;

/** The exact text served for a document version. */
export function canonicalDocumentText(def: LegalDocumentDefinition): string {
  return def.paragraphs.join('\n\n');
}

/** SHA-256 (hex) of the exact served text — the verifiable part of a consent. */
export function legalContentHash(def: LegalDocumentDefinition): string {
  return createHash('sha256').update(canonicalDocumentText(def), 'utf8').digest('hex');
}

export interface CurrentLegalDocument {
  type: LegalDocumentTypeValue;
  version: string;
  title: string;
  url: string;
  effectiveFrom: string;
  contentHash: string;
  paragraphs: readonly string[];
}

/** The documents currently in force, with their hashes. Safe to expose publicly. */
export function currentLegalDocuments(): CurrentLegalDocument[] {
  return CURRENT_LEGAL_DOCUMENTS.map((def) => ({
    type: def.type,
    version: def.version,
    title: def.title,
    url: def.url,
    effectiveFrom: def.effectiveFrom,
    contentHash: legalContentHash(def),
    paragraphs: def.paragraphs,
  }));
}

export function findCurrentDocument(type: LegalDocumentTypeValue): CurrentLegalDocument {
  const found = currentLegalDocuments().find((doc) => doc.type === type);
  if (!found) throw new Error(`Unknown legal document type: ${type}`);
  return found;
}
