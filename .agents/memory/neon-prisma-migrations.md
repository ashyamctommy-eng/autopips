---
name: Neon Prisma migration routing
description: Use direct Neon connections for Prisma migration commands and diagnose pooled advisory-lock residue safely.
---

Keep runtime database traffic on the pooled `DATABASE_URL`, but configure Prisma Migrate with the direct Neon connection through `directUrl = env("DIRECT_URL")`. A migration run over a pooled Neon URL can leave its session-level advisory lock on an idle PgBouncer backend after the command exits, causing later migration commands to time out.

**Why:** A baseline command succeeded, then a later Prisma command hit P1002 while a single idle pooler backend retained the migration lock. Routing migrations through the direct URL avoided the issue.

**How to apply:** On migration lock timeouts, inspect `pg_locks` and `pg_stat_activity`, then use the direct URL. Release only a verified stale idle migration holder; do not clear arbitrary or active locks.