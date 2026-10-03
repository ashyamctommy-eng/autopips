---
name: TSX inline probes
description: Silent no-op observed with an explicit tsconfig flag in inline runtime checks
---
In this workspace, `pnpm --filter @workspace/api-server exec tsx --tsconfig
tsconfig.json -e ...` repeatedly returned exit zero without executing even the
first diagnostic print. The same probe without `--tsconfig` executed correctly,
using the package's automatically discovered configuration.

**Why:** This otherwise looks like a passing market-data check despite providing
no evidence that the provider request ran.

**How to apply:** For inline probes use automatic configuration discovery and
require an explicit result, not merely exit zero. Recheck this behavior after
toolchain updates; it is an observed local quirk, not a general TSX rule.