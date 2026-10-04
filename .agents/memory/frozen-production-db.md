---
name: Frozen production database
description: Recovery path for a frozen Replit-managed PostgreSQL production database.
---

When the production database probe reports that the database is frozen, Replit requires the app owner or an administrator to unpause it in the Database pane. The agent cannot unfreeze it through an API. A development database that still answers does not prove production is available. Replit-managed production schema changes are applied through Publish, not by manually running production DDL.

**Why:** A production-only freeze caused published Prisma requests to report the database unreachable while development SQL probes continued to work.

**How to apply:** Stop before changing database URLs, running production migrations, or republishing. Ask the owner to unpause Production, then retry read-only connectivity and schema checks. If the unpause control is missing, check for a conflicting manual `DATABASE_URL` secret against the Database pane's connection details.