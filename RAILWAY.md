# Deploying Autopipsz to Railway

Railway runs the two processes this platform needs as **two services**, with
managed **Postgres** and **Redis** alongside them. There is no `docker-compose`
here — Railway replaces it.

```
Railway project: autopips
├── Postgres           (managed plugin)  → DATABASE_URL
├── Redis              (managed plugin)  → REDIS_URL
├── worker   ← Dockerfile.worker, railway.worker.toml, 1 replica, PUBLIC domain
└── web      ← Dockerfile,        railway.toml,         public domain
```

> **Why two services.** A Next.js App Router app cannot host a Socket.IO server,
> and the bot runtime takes a Redis lock so only one process may trade. The web
> tier is stateless and scales; the worker is a singleton.

---

## Order matters — do it in this sequence

`NEXT_PUBLIC_WS_URL` is **inlined into the client bundle at build time**. The web
service therefore needs the worker's public domain to exist *before* its first
build. That is why the worker is created first.

---

## 1. Create the project and the datastores

1. <https://railway.app/new> → **Deploy from GitHub repo** → `ashyamctommy-eng/autopips`.
   Choose **Empty Project** first if prompted; you will add services deliberately.
2. In the project: **+ New** → **Database** → **Add PostgreSQL**.
3. **+ New** → **Database** → **Add Redis**.
4. Confirm both have a green status. Do **not** expose either publicly — service
   references use Railway's private network.

---

## 2. Create the WORKER service

1. **+ New** → **GitHub Repo** → `ashyamctommy-eng/autopips`.
2. Rename the service to **`worker`**.
3. **Settings → Build**:
   - Builder: **Dockerfile**
   - Dockerfile Path: **`Dockerfile.worker`**
4. **Settings → Config-as-code** → Config File Path: **`/railway.worker.toml`**
5. **Variables** → add (use **New Variable → Add Reference** for the two
   datastores so they track Railway's own values):

   | Variable | Value |
   | --- | --- |
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
   | `REDIS_URL` | `${{Redis.REDIS_URL}}` |
   | `NODE_ENV` | `production` |
   | `NEXT_PUBLIC_APP_URL` | `https://autopips.pro` (or your web domain — see §4) |
   | `JWT_SECRET` | *generate — see §3* |
   | `CREDENTIAL_ENCRYPTION_KEY` | *generate — see §3* |
   | `WS_INTERNAL_TOKEN` | *generate — see §3* |
   | `NOWPAYMENTS_API_KEY` | from NOWPayments dashboard |
   | `NOWPAYMENTS_IPN_SECRET` | from NOWPayments dashboard |
   | `METAAPI_TOKEN` | from MetaApi dashboard |
   | `AWS_REGION` | e.g. `eu-west-1` |
   | `AWS_ACCESS_KEY_ID` | IAM user with `s3:PutObject`/`GetObject` on the KYC bucket |
   | `AWS_SECRET_ACCESS_KEY` | as above |
   | `AWS_KYC_BUCKET` | your private bucket name |

   > Every variable in `.env.example` must be present — `src/lib/env.ts` validates
   > the whole contract at boot and **exits non-zero** if anything is missing or
   > malformed. `scripts/preflight.sh` can check a local copy first.

6. **Settings → Networking** → **Generate Domain**. Note it, e.g.
   `autopips-worker-production.up.railway.app`. **This is your `NEXT_PUBLIC_WS_URL`.**

7. Deploy. The worker also applies **no migrations** — it must not race the web
   service. Leave it running; it will report unhealthy until the schema exists,
   which is expected at this point.

---

## 3. Generate the three secrets

Run these locally (or use any CSPRNG — do **not** reuse the values from `.env`):

```bash
openssl rand -base64 48      # JWT_SECRET                (>= 32 chars)
openssl rand -base64 32      # CREDENTIAL_ENCRYPTION_KEY (must decode to >= 32 bytes)
openssl rand -hex 32         # WS_INTERNAL_TOKEN
```

`CREDENTIAL_ENCRYPTION_KEY` encrypts MetaApi tokens at rest (AES-256-GCM). **If you
change it later, every stored broker token becomes undecryptable** and must be
re-entered in `/admin/brokers`.

---

## 4. Create the WEB service

1. **+ New** → **GitHub Repo** → `ashyamctommy-eng/autopips`.
2. Rename to **`web`**.
3. **Settings → Build**: Builder **Dockerfile**, Dockerfile Path **`Dockerfile`**.
4. **Settings → Config-as-code** → Config File Path: **`/railway.toml`**
5. **Variables** — same list as the worker, plus:

   | Variable | Value |
   | --- | --- |
   | `NEXT_PUBLIC_WS_URL` | `https://<worker domain from §2.6>` — **no trailing slash** |
   | `NEXT_PUBLIC_APP_URL` | `https://autopips.pro` (the browser origin users see) |
   | `NEXT_PUBLIC_APP_NAME` | `Autopipsz` |
   | `WS_PORT` | `4001` (unused here; the web tier never binds it) |

   `NEXT_PUBLIC_APP_URL` is **not cosmetic**: the worker uses it as the
   socket CORS allow-list. If it does not exactly match the origin in the
   browser's address bar, realtime connections are rejected by CORS with
   `credentials: true`.

6. **Settings → Networking** → **Generate Domain**, then attach your custom
   domain `autopips.pro` (+ `www`) and add the CNAME Railway shows you.
7. Deploy. The start command runs `prisma migrate deploy` **before** `npm start`,
   so the initial migration is applied on this first deploy.

---

## 5. Point the browser at the right socket host

The web and worker services are on **different origins**, so the httpOnly access
cookie is not sent to the worker's handshake (it is host-only and `SameSite=Lax`).
The client handles this automatically: `src/lib/socket-client.ts` detects a
cross-origin `NEXT_PUBLIC_WS_URL`, fetches a short-lived token from
`GET /api/v1/auth/socket-token`, and presents it as `handshake.auth.token`.

Two consequences to be aware of:

- **`NEXT_PUBLIC_WS_URL` requires a REBUILD, not a restart.** It is inlined into
  the client bundle. After changing it: **Deploy → Redeploy → clear build cache**.
  A plain restart will keep serving the old value.
- Any change to the web service's public domain means `NEXT_PUBLIC_APP_URL` must
  be updated on the **worker** too (CORS), and the worker restarted.

---

## 6. Verify the deployment

```bash
# 1. Web health — must be 200 with both dependencies "ok"
curl -s https://autopips.pro/api/v1/health | jq

# 2. Worker health — reachable and reporting its datastores
curl -s https://<worker-domain>/healthz | jq

# 3. Public site + API
curl -s -o /dev/null -w '%{http_code}\n' https://autopips.pro/
curl -s https://autopips.pro/api/v1/plans | jq '.ok'

# 4. The IPN endpoint must be reachable and REJECT an unsigned body (401).
#    A 404 here means the route is missing; a 200 means signature checking is off.
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  https://autopips.pro/api/v1/payments/nowpayments/ipn \
  -H 'content-type: application/json' -d '{"payment_id":"x","payment_status":"finished"}'
```

Then, in the browser:

- Sign in, and confirm the **Bot status** indicator goes live on
  `/dashboard/trading` (a green `LiveDot`). If it stays disconnected, open the
  devtools Network tab and check the `/ws/socket.io` handshake — the usual causes
  are `NEXT_PUBLIC_APP_URL` not matching the origin (CORS) or a stale
  `NEXT_PUBLIC_WS_URL` baked into the bundle.
- Confirm realtime actually pushes: the activity feed should show entries as the
  bot runs.

### Register the payment webhook

In the NOWPayments dashboard set the IPN callback URL to:

```
https://autopips.pro/api/v1/payments/nowpayments/ipn
```

It must be **HTTPS** and must not be behind anything that rewrites the request
body — the route verifies an HMAC over the **raw** body text.

---

## 7. First-run checklist

Do these in order; each one depends on the previous.

1. `GET /api/v1/health` returns 200.
2. Create your admin account via `POST /api/v1/auth/register`, then promote it:
   ```bash
   railway connect Postgres      # or use the Railway dashboard's Data tab
   UPDATE "User" SET role = 'ADMIN', "kycStatus" = 'APPROVED' WHERE email = 'you@example.com';
   ```
3. Sign in at `/login`, enable 2FA in `/dashboard/settings`.
4. Add the MetaApi account in `/admin/brokers` → the connection must read
   `CONNECTED` with a real balance. Until it does, the bot does nothing and the
   chart shows its empty state — that is correct, not broken.
5. Create plans in `/admin/plans`.
6. Send a **live minimum deposit** through the real NOWPayments flow and confirm
   it credits exactly once in the client's deposit history.
7. Submit one KYC file as a test client and walk the admin review, confirming the
   signed document URLs expire after 300 seconds.

---

## 8. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Deploy fails: `Environment variable not found: DATABASE_URL` | Variable missing on that service | Add the reference. `prisma validate`/`migrate` need it at build and boot. |
| Deploy fails at `prisma migrate deploy` | Missing `DATABASE_URL`, or the DB is not up | Check the Postgres plugin status; confirm the variable is a reference, not a hardcoded URL. |
| Web boots, `/api/v1/health` returns 503 | Postgres or Redis unreachable | Check the plugin is green and `REDIS_URL` is set on the **web** service too. |
| Site loads but realtime never connects | `NEXT_PUBLIC_WS_URL` wrong, or `NEXT_PUBLIC_APP_URL` does not match the browser origin | Fix the variables, then **rebuild** the web service (clear build cache). |
| Socket connects then immediately disconnects | Worker rejected the handshake | Check worker logs for `[ws] unauthorized`. Usually a CORS origin mismatch or an expired token — the client re-fetches one per attempt. |
| `Error: P1013` / SSL errors on migrate | Using the **public** Postgres URL instead of the reference | Use `${{Postgres.DATABASE_URL}}` (private network). |
| Worker crash-loops on `bot runtime lock held` | More than one replica running | Set `numReplicas = 1` (already in `railway.worker.toml`). |
| Healthcheck times out | `PORT` not honoured | The app binds `PORT` when present; confirm you did not override it with a conflicting variable. |
| Deposits never credit | IPN not registered, or secret mismatch | Re-check the callback URL and `NOWPAYMENTS_IPN_SECRET`; look for `DEPOSIT_IPN_REJECTED` in `/admin/logs`. |

---

## 9. Scaling notes

- **web** — stateless; raise replicas freely. Sessions are JWT + Redis, so no
  sticky sessions are required.
- **worker** — keep at **1 replica**. The bot holds a Redis lock; extra replicas
  serve sockets but refuse to trade. To scale the realtime tier you must split
  the socket server and the bot runtime into two services first.
- Both services hold Prisma connection pools. If you scale the web tier, lower
  `connection_limit` in the `DATABASE_URL` query string (e.g.
  `?connection_limit=5`) so replicas do not exhaust the plan's Postgres limit.

---

## 10. Rollback

Railway keeps prior deployments: **Deployments → ⋯ → Redeploy** on the last good
build. Note that **migrations are forward-only** — there are no down migrations.
If a release included a destructive schema change, rolling the code back does not
roll the schema back; restore from a Postgres backup instead
(**Postgres service → Backups**, and enable them before you need them).
