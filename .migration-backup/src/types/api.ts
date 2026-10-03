/**
 * Wire DTOs shared by API routes and the React client.
 *
 * Rule: these types describe *verified* data only. There is no field here that
 * a UI could fill with a placeholder value.
 */

export interface SessionUser {
  id: string;
  email: string;
  fullName: string;
  role: 'CLIENT' | 'ADMIN' | 'TRADING_MANAGER';
  kycStatus: KycStatusValue;
  is2FAEnabled: boolean;
  country: string;
  createdAt: string;
}

export type KycStatusValue =
  | 'NOT_SUBMITTED'
  | 'PENDING'
  | 'UNDER_REVIEW'
  | 'APPROVED'
  | 'REJECTED'
  | 'ADDITIONAL_INFO_REQUIRED';

export type PaymentStatusValue =
  | 'PENDING'
  | 'WAITING'
  | 'CONFIRMED'
  | 'SENDING'
  | 'FINISHED'
  | 'FAILED'
  | 'REFUNDED';

export type InvestmentStatusValue =
  | 'PENDING'
  | 'ACTIVE'
  | 'PAUSED'
  | 'MATURED'
  | 'CANCELLED'
  | 'CLOSED';

/** /api/v1/account/overview */
export interface AccountOverview {
  equity: number;
  breakdown: {
    /**
     * Capital currently DEPLOYED with a strategy. Together with
     * `unallocatedCash` this is the capital half of the equity formula — the
     * two are a partition of contributed capital and never overlap.
     */
    startingCapital: number;
    realizedPnL: number;
    unrealizedPnL: number;
    deductedFees: number;
    withdrawals: number;
    /** Confirmed deposits not yet deployed (idle cash). */
    confirmedDeposits: number;
    /** = startingCapital + confirmedDeposits = net contributed capital. */
    netContributedCapital: number;
    /** Gross deposits ever credited, for the deposit history headline. */
    totalCreditedDeposits: number;
    /** Gross withdrawals ever paid. */
    totalPaidWithdrawals: number;
  };
  netProfit: number;
  netReturnPct: number;
  grossPnL: number;
  activeCapital: number;
  withdrawableBalance: number;
  pendingWithdrawals: number;
  formula: string;
  disclaimer: string;
}

export interface InvestmentDTO {
  id: string;
  planId: string;
  planName: string;
  riskLevel: string;
  capitalUsd: number;
  currentValUsd: number;
  realizedPnL: number;
  unrealizedPnL: number;
  feesDeducted: number;
  status: InvestmentStatusValue;
  startDate: string | null;
  maturityDate: string | null;
  /** Indicative objective only — never a promise. */
  targetReturnMin: number;
  targetReturnMax: number;
  createdAt: string;
}

export interface PositionDTO {
  id: string;
  derivContractId: string | null;
  investmentId: string;
  instrument: string;
  direction: 'BUY' | 'SELL' | string;
  volume: number;
  entryPrice: number;
  currentPrice: number | null;
  exitPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  grossPnL: number;
  commission: number;
  swap: number;
  netPnL: number;
  floatingPnL: number;
  status: 'OPEN' | 'CLOSED' | 'CANCELLED' | string;
  openedAt: string;
  closedAt: string | null;
}

export interface DepositDTO {
  id: string;
  amountUsd: number;
  cryptoCurrency: string;
  paymentId: string;
  depositAddress: string;
  payAmount: number;
  status: PaymentStatusValue;
  createdAt: string;
  updatedAt: string;
}

export interface WithdrawalDTO {
  id: string;
  amountUsd: number;
  cryptoCurrency: string;
  payoutAddress: string;
  feeUsd: number;
  status: PaymentStatusValue;
  txHash: string | null;
  createdAt: string;
}

export interface TradingPlanDTO {
  id: string;
  name: string;
  description: string;
  minInvestment: number;
  maxInvestment: number;
  durationDays: number;
  targetReturnMin: number;
  targetReturnMax: number;
  riskLevel: string;
  performanceFee: number;
  managementFee: number;
  maxDrawdown: number;
  isActive: boolean;
  /** Present so no client can render a target without the caveat. */
  targetReturnLabel: string;
  /** Live, verified aggregate stats. Null when there is no realised history yet. */
  stats: StrategyStats | null;
}

export interface StrategyStats {
  planId: string;
  closedTrades: number;
  winningTrades: number;
  losingTrades: number;
  /** winningTrades / closedTrades * 100. Null when closedTrades is 0. */
  winRatePct: number | null;
  grossProfit: number;
  grossLoss: number;
  netPnL: number;
  /** Sum of netPnL / sum of capital deployed, as %. Null when no history. */
  observedReturnPct: number | null;
  maxObservedDrawdownPct: number | null;
  firstTradeAt: string | null;
  lastTradeAt: string | null;
  /** Always true — the UI must render the non-guarantee caveat. */
  indicativeOnly: true;
}

export interface ActivityEventDTO {
  id: string;
  action: string;
  message: string;
  severity: 'info' | 'success' | 'warning' | 'error';
  details: Record<string, unknown>;
  createdAt: string;
}

export interface BrokerConnectionDTO {
  id: string;
  derivAccountId: string;
  brokerName: string;
  environment: 'LIVE' | 'DEMO' | string;
  maskedAccount: string;
  /** Null when the broker did not report the figure (never a filled-in zero). */
  balance: number | null;
  equity: number | null;
  freeMargin: number | null;
  status: string;
  updatedAt: string;
  /** Populated from a live broker round-trip probe; null when not probed this request. */
  latencyMs: number | null;
}

export interface KycProfileDTO {
  id: string;
  legalName: string;
  dob: string;
  address: string;
  idType: string;
  idNumberMasked: string;
  status: KycStatusValue;
  rejectionReason: string | null;
  reviewedAt: string | null;
  createdAt: string;
  documents: { kind: string; uploaded: boolean }[];
}

/** Admin: pending KYC queue row. */
export interface KycReviewRow {
  id: string;
  userId: string;
  email: string;
  fullName: string;
  country: string;
  legalName: string;
  idType: string;
  status: KycStatusValue;
  createdAt: string;
}

export interface AumSummary {
  totalManagedCapital: number;
  totalEquity: number;
  openMarketExposure: number;
  openPositions: number;
  netTodayPnL: number;
  pendingKycCount: number;
  activeClients: number;
  openInvestments: number;
  /** Aggregate of every verified ledger row across the platform. */
  platformBreakdown: {
    realizedPnL: number;
    unrealizedPnL: number;
    deductedFees: number;
    withdrawalsPaid: number;
    confirmedDeposits: number;
  };
}

export interface AuthLoginResponse {
  user: SessionUser;
  /** Present only when 2FA is required to complete the login. */
  requires2FA: boolean;
  challengeId?: string;
}

export interface ApiEnvelope<T> {
  ok: true;
  data: T;
  disclaimer?: string;
}

export interface ApiErrorEnvelope {
  ok: false;
  error: { code: string; message: string; details?: unknown };
}

/* ───────────────────────── internal positions (EXECUTION_MODE) ──────────── */

/**
 * An INTERNALLY-EXECUTED position (`EXECUTION_MODE=internal`).
 *
 * Distinct from the broker `PositionDTO` above: this is a platform liability
 * priced off the market-data feed, so it carries a `stake` (money at risk), a
 * `multiplier`, and a single `pnl`. Renamed to keep the two unambiguous.
 */
export interface InternalPositionDTO {
  id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  /** Money at risk — the maximum loss on this position, USD. */
  stake: number;
  multiplier: number;
  entryPrice: number;
  currentPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
  /** Unrealized while OPEN (live mark); frozen once CLOSED. */
  pnl: number;
  status: 'OPEN' | 'CLOSED' | 'CANCELLED';
  executionMode: string;
  closePrice: number | null;
  openedAt: string;
  closedAt: string | null;
}

/**
 * A client's wallet, DERIVED from the ledger — there is no `User.balance`
 * column. Every figure here comes from `getAccountSnapshot`, so the wallet can
 * never disagree with the dashboard, the admin projection or the equity formula.
 */
export interface WalletDTO {
  /** Equity minus deployed capital minus pending withdrawals (spendable now). */
  availableUsd: number;
  /** Capital locked in ACTIVE/PAUSED investments plus OPEN position stakes. */
  deployedUsd: number;
  equityUsd: number;
  pendingWithdrawalsUsd: number;
  netContributedCapitalUsd: number;
  openInvestments: number;
  openPositions: number;
  /** The single equity formula, surfaced so the UI can show its own arithmetic. */
  formula: string;
}
