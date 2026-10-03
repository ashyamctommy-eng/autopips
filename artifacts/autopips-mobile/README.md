# Autopipsz Mobile

Separate Expo companion for existing Autopipsz accounts. This is read-only:
overview, server-derived wallet totals, internal/broker positions, and the latest
50 account events. No balances are seeded and no trading/payment controls exist.

## Run

- Managed workflow: `artifacts/autopips-mobile: expo`.
- Requires the existing API server and Redis workflows.
- Development injects `EXPO_PUBLIC_DOMAIN` from the workspace domain.
- A release build must set `EXPO_PUBLIC_DOMAIN` to the **existing API's HTTPS
  hostname** (without scheme or path), not the Expo hosting hostname. No backend
  credentials belong in any `EXPO_PUBLIC_*` variable.
- Type check: `pnpm --filter @workspace/autopips-mobile typecheck`.
- Native bundle check: `pnpm --filter @workspace/autopips-mobile exec expo export
  --platform ios --platform android --output-dir /tmp/autopips-mobile-export`.

## Security and data

`/api/mobile/auth/*` adapts the original password, single-use TOTP challenge,
refresh rotation, rate limiting and logout/revocation handlers. It captures
their cookie writes as JSON credentials without emitting browser cookies.
Bearer access is restricted to the mobile route namespace; browser auth and
money-moving routes are unchanged. `/api/mobile/account` resolves the current
session owner and ignores client-supplied account IDs.

Native session pairs are stored together in Expo SecureStore. Browser previews
keep them only in memory and intentionally sign out on reload. Refresh is
single-flight. Logout waits for refresh, revokes the server session, removes
device credentials and clears query data. A failed logout remains retryable
rather than falsely claiming server revocation.

Overview amounts come directly from the existing Decimal ledger snapshot as
strings. Position DTOs retain the existing service semantics. All position
values are explicitly labeled as stored, not live; unknown broker prices and
unverified open broker P/L remain unavailable. Provider availability messaging
does not claim live market connectivity. Internal execution explicitly disables
external payments and discloses the platform as counterparty.

## Verification limits

Native bundle export verifies both platform bundles, not device Keychain or
Keystore behavior. Test native session restoration and two-factor sign-in on
physical devices before an app-store release.