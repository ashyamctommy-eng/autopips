/** Frontend-safe copies of server DTO shapes (types only). */
export interface TradeDTO {
  id: string;
  investmentId: string;
  derivContractId: string | null;
  instrument: string;
  direction: string;
  volume: number;
  entryPrice: number;
  exitPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  grossPnL: number;
  commission: number;
  swap: number;
  netPnL: number;
  status: string;
  openedAt: string;
  closedAt: string | null;
}
export type PlatformSettingKey =
  | 'nowpayments.api_key'
  | 'nowpayments.ipn_secret'
  | 'nowpayments.api_base'
  | 'nowpayments.allowed_currencies'
  | 'deriv.api_token'
  // ── market data (Admin → Settings) ──
  | 'twelve_data.api_key'
  | 'market.instruments'
  // ── public disclosure (Admin → Settings) ──
  | 'disclosure.internal_execution_notice'
  // ── payout controls (Admin → Settings) ──
  | 'payout.daily_cap_usd'
  | 'payout.address_allowlist'
  | 'payout.two_person_approval'
  // ── bot risk controls (Admin → Bot control) ──
  | 'bot.enabled'
  | 'bot.disabled_reason'
  | 'risk.max_stake_usd'
  | 'risk.risk_per_trade_pct'
  | 'risk.daily_loss_limit_usd'
  | 'risk.allowed_symbols'
  | 'risk.min_payout_percentage'
  // ── engine controls (Admin → Settings) ──
  | 'engine.worker_enabled';
export interface AdminSettingView {
  key: PlatformSettingKey;
  label: string;
  description: string;
  kind: SettingKind;
  secret: boolean;
  /**
   * The definition's built-in default. Used to seed a `longtext` editor so the
   * admin edits the real text instead of an empty box. Never secret material
   * (a secret definition's default is always empty).
   */
  defaultValue: string;
  inputHint: string;
  /** Where the effective value comes from right now. */
  source: 'console' | 'environment' | 'unset';
  /** Masked for secrets; verbatim for everything else. Never a secret. */
  display: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}
export type SettingKind =
  | 'secret'
  | 'url'
  | 'list'
  | 'symbols'
  | 'addresses'
  | 'number'
  | 'boolean'
  | 'text'
  /**
   * Multi-paragraph prose (a public disclosure). Unlike `text` (500 chars,
   * single-line) this preserves line breaks and allows a real document, and the
   * console renders it as a textarea.
   */
  | 'longtext';
