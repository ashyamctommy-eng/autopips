---
name: Vercel app-root config
description: Vercel-specific routing and output paths when the project root is a workspace artifact folder.
---

Vercel's project Root Directory is `artifacts/autopips`, not the repository root. Put Vercel-specific configuration in that folder and make output paths relative to it (`dist/public`).

**Why:** The root-level Vercel rewrite is ignored when Vercel is configured to treat the frontend artifact directory as its project root; deep links then return Vercel 404s.

**How to apply:** Keep the app-root `vercel.json` in sync with the Vite build output and SPA rewrite to `/index.html`. If changing Vercel's Root Directory, review which `vercel.json` Vercel will read and adjust output paths accordingly.
