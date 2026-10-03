# Dependency remediation verification

Verified on 2026-10-03.

## Inventory and automatic fixes

A filesystem walk from the workspace root pruned dependency, VCS, and build
directories before descent. It included hidden and untracked files.
The initial inventory contained 17 JavaScript manifests and two lockfiles:

- Root `package.json`, governed by `pnpm-lock.yaml` and `pnpm-workspace.yaml`.
- `artifacts/{api-server,autopips,mockup-sandbox}/package.json`.
- `lib/{api-client-react,api-spec,api-zod,db}/package.json`.
- `scripts/package.json`.
- `.migration-backup/package.json`, with its independent npm lockfile.
- Seven `.local/skills/*/templates/lib/*/package.json` files (Anthropic, Gemini,
  OpenAI client/server, OpenRouter, object storage, and Replit auth templates).
  These are uninstalled workspace templates, not independent installed apps;
  no listed vulnerable versions were declared in them.

`pnpm audit --fix` was run from every pnpm manifest directory, including the
templates. pnpm resolves the shared workspace lockfile even from those
directories. `npm audit fix --package-lock-only --ignore-scripts` was run
from the archived npm project. Automatic fixes were supplemented by direct
upgrades and targeted workspace overrides, then both lockfiles regenerated.
The new hardened-fork manifest was also audited.

## Remediation

| Reported dependency | Resolution |
| --- | --- |
| Next 14.2.35 | Archive upgraded to Next 15.5.27 and matching eslint-config-next. The active Vite app does not depend on Next. |
| PostCSS 8.4.31 | PostCSS 8.5.28, including an npm override for the archive's transitive copy. |
| Vitest 2.1.9 / 3.2.7 and matching mockers | Vitest and mocker 4.1.11 in both dependency trees. |
| Vite 5.4.21 | Removed with the Vitest upgrade; active workspace uses Vite 7.3.6. |
| esbuild 0.21.5 | Removed; patched esbuild releases resolve in both trees. |
| brace-expansion 5.0.9 | Targeted override to 5.0.12. |
| fast-uri 3.1.7 | Targeted override to 3.1.8. |
| lodash 4.17.23 | Resolves to patched 4.18.1. |
| glob 10.3.10 | Removed through the archive's eslint-config-next upgrade. |
| braces 3.0.3 | Replaced in both trees by a licensed local hardened fork. |

GHSA-vfj7-8cjw-p6xm has **no upstream patched braces version**. The actual
recursive code is retained with enforced parser-depth limits and iterative
AST validation before every recursive entry point. Tests cover nested braces,
parentheses, malformed/unclosed patterns, AST cycles, invalid parent links,
caller attempts to disable limits, and upstream length/range limits.
See `lib/guarded-braces/README.md` for provenance and maintenance instructions.
This is not merely a version rename, a scan exclusion, or an advisory waiver.

The archive uses a direct local dependency and an npm `$braces` override so
the local path resolves correctly for all transitive consumers. Its lockfile
was regenerated from scratch to remove stale, invalid local links.
The one-day pnpm minimum release age and registry firewall remain enabled.

## Checks

- `pnpm audit`: no known vulnerabilities.
- Archived project's `npm audit`: zero vulnerabilities in every severity.
- Fresh Replit dependency scan: zero findings in every severity.
- `pnpm security:check-pins`: checks all 18 current manifests and both
  lockfiles; none of the reported package/version pairs remain.
- `pnpm --filter @workspace/guarded-braces test`: all four security and
  compatibility test groups pass.
- Additional differential check: all 1,277 cases accepted by upstream braces
  matched fork output. Three cases already error in upstream.
- `PORT=20895 BASE_PATH=/ pnpm build`: full workspace typecheck and production
  builds pass (frontend, API/worker bundles, and mockup sandbox).
- API migration-boundary tests: all four pass with Vitest 4.1.11.
- Restarted web, API, and mockup workflows successfully. Public homepage
  renders without browser errors, and `/api/healthz` returns HTTP 200.
- `git diff --check`: passes.

Build verification also required small existing migration typing corrections:
nullable React refs, a typed instrument set, missing backend declaration
packages, and exclusion of four copied browser-only files from the backend
TypeScript entry set. Server-imported modules remain checked normally.

## Verification limits

The complete inherited backend suite was attempted: 479 tests passed,
13 failed, four skipped, with seven additional suite-loading failures.
Failures referenced original pre-migration file paths or unavailable
service credentials/Redis. No financial database migrations, account seeds,
external-provider operations, or trading-worker startup were performed to
make those checks pass. This is not a claim that the full backend suite passed.

The archived Next project is a source reference, not a running artifact; its
dependency tree is audited, but its archived UI was not built or run.
Signed-in application screens and live trading were not verified.