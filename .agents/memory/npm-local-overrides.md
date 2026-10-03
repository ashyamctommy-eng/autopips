---
name: npm local overrides
description: Why directory overrides need a direct dependency and a fresh lockfile
---

When an independent npm project substitutes a transitive dependency with a
local directory, declare that local package directly and reference it with
`$dependency` in overrides. Verify every resulting local link in the lockfile,
not just the audit count.

**Why:** npm 11 accepted a directory override and reported zero vulnerabilities
while creating a nonexistent `node_modules/lib/...` target for nested
consumers. Adding the direct dependency did not remove the stale nested links;
regenerating the lockfile did.

**How to apply:** For local replacements, inspect link targets after
regeneration and ensure they lead to a real package with recorded metadata.
Keep the archived npm dependency tree separate from the active pnpm workspace.