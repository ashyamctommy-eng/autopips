---
name: Worker restart leases
description: Temporary worker inactivity after managed workflow restarts
---
Managed restarts can leave the outgoing worker's Redis leases alive until their
TTL expires. The replacement boot supervisor then needs its next retry to acquire
them; an HTTP 200 health response alone does not prove the trading loop resumed.

**Why:** Observed during local environment configuration: only the replacement
worker process remained, but its trading loop reported LOCK_HELD until expiry
and a later supervisor retry.

**How to apply:** Check process ownership, remaining lease TTL, and the nested
trading status. Allow bounded recovery and confirm the loop actually started.
Do not delete a lease unless its ownership and safety have been established.