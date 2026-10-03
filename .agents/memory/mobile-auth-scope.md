---
name: Mobile authentication scope
description: Why the companion adapts existing identity instead of introducing a second auth provider.
---

The companion should reuse Autopipsz's existing password, two-factor and session
revocation semantics rather than migrate clients to a different identity provider.
Keep mobile bearer transport restricted to the companion's read-only boundary.

**Why:** The mobile companion must let existing clients check the same accounts
without changing browser authorization or creating a new route to financial
mutations. A broad bearer-auth retrofit would exceed that scope.

**How to apply:** For future mobile features, explicitly assess any expansion
from read-only access; do not automatically enable bearer credentials across the
legacy trading, payment or staff routes.