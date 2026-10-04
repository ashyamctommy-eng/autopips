---
name: React type-version seams
description: Keep type-only React version conflicts contained at third-party component boundaries.
---

When pnpm resolves different `@types/react` versions for an app and a third-party
declaration, first confirm runtime React versions are compatible. Prefer a
narrowly typed adapter at the component boundary (for example, derive props from
the imported component or cast a structurally equivalent ref) over a workspace-
wide override.

**Why:** The web artifact and Expo app can intentionally use different React
type versions. A global override may silence one UI-library mismatch but break
the Expo/React Native toolchain.

**How to apply:** Inspect the resolved type paths and package graph. If the
mismatch is limited to a small number of declaration boundaries, contain it
there and keep the affected package in the regular workspace typecheck/build.
Only align shared versions as part of an intentional dependency upgrade.