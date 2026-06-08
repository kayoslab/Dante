<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Project conventions

These were extracted from TECH_DEBT.md when it was closed out. They're the durable decisions, not pending work.

## Wire shape

- **snake_case keys** end-to-end. The DB uses snake_case (Drizzle table objects are snake_case), the API returns snake_case, the FE consumes snake_case. Don't add a camelCase boundary layer.
- **`{ detail, code }` error envelope** for all `/api/*` route handlers. Thrown via the `HTTPError` factories in `lib/api/_route-helpers.ts` and turned into JSON by `handle()`.
- **Wire types live in `lib/api/types.ts`** as a flat module. The query-side types live in `lib/db/queries/*` next to their query. Don't try to merge the two — wire shape and query shape diverge per route.

## Money & decimals

- **Monetary `numeric()` columns stay as `string`** through the stack because the cost/revenue math uses `decimal.js` which consumes strings. Converting to `number` loses cents on big aggregates.
- Only `fte` is `number` (it's a small fraction, precision is fine).
- If you add a new monetary field, follow the same convention (Drizzle's default `mode` for numeric is already string).

## Roles + auth

- **`requireSession({ minRole })`** at the top of every Server Component page / Server Action.
- **`requireApiSession({ minRole })`** inside `handle()` on every `/api/*` route. The proxy enforces "signed in or not"; per-route role enforcement is on you.
- Role split (the one the user spec'd):
  - **employee** sees: `/calendar`, `/profile`, `/employees` (list only), `/api/calendar`, `/api/employees`, `/api/employees/teams`.
  - **manager** adds: everything financial — `/api/portfolio/*`, `/api/salary/*`, `/api/projects/*`, `/api/employees/[id]` (detail), `/api/freelancers/*`, etc.
  - **admin** adds: `/settings`, `/api/config`, `/auth/awork/*`.

## MFA (TOTP)

- **In-app TOTP**, not Cognito SOFTWARE_TOKEN_MFA. Same code path in dev and prod; no Auth.js custom challenge handling.
- Library: `otplib@12` + `qrcode`. The `authenticator` instance in `lib/auth/mfa.ts` uses default RFC 6238 settings (30s step, ±30s tolerance).
- Required by default for **admin** and **manager**. Employees can opt in via `/profile` (not yet wired in UI — schema supports it).
- Per-session, not per-device: `mfa_verified` lives in the JWT. A new sign-in starts with `mfa_verified = false` and the user is bounced to `/auth/mfa/verify` (or `/auth/mfa/setup` if not enrolled).
- The TOTP secret is in `app_user.mfa_secret` (plain base32). Postgres TDE handles at-rest encryption; app-layer encryption is a later upgrade if the row count grows.
- **Enforcement points**: `requireSession()` and `requireApiSession()` both redirect/throw if `mfa_required && !mfa_verified`. The MFA pages themselves pass `{ allowMfaPending: true }` to opt out of the bounce.

**Reset (lost device)**: admin clicks "Reset MFA" on `/settings/users`. This calls `resetUserMfaAction` which nulls `mfa_secret` + `mfa_enrolled_at`; the user re-enrolls on next sign-in. The action is audited as `user_mfa_reset`.

**Auto-enable on promotion**: `setUserRoleAction` flips `mfa_required = true` when promoting to manager/admin. Demoting does NOT auto-clear — admins toggle off explicitly if they want.

**Promotions / new invites**: `inviteUserAction` writes `mfa_required = role !== "employee"`.

## awork integration

- **Read-only invariant.** The data-path client (`lib/sync/awork/client.ts`) only exposes `list*` / `get*`. The only POST in the codebase is to awork's OAuth token endpoint, and it lives in `lib/sync/awork/auth.ts`.
- Enforced by `scripts/check-awork-readonly.ts`, wired into `npm run check`. Adding a new write path requires editing `ALLOWED_POST_FILES` in the script — visible in code review.

## Sync layer

- **Typed Drizzle writes.** Sync uses `db.insert(table).values(...).onConflictDoUpdate({ target, set })` so column renames break at compile time. Wrap the standalone `Client` with `syncDrizzle(conn)` at the call site.
- **`excludedSet([...cols])`** in `lib/sync/_upsert.ts` builds the `set` map for ON CONFLICT updates — derived from a single column list so a schema change needs one edit.
- **Per-employee transactions** via raw `conn.query("BEGIN")` / `COMMIT` — Drizzle's transaction API is fine too, but the raw `BEGIN`/`COMMIT` lets a single bad record roll back without poisoning the rest of the run.

## Secrets

- **`DANTE_USE_SECRETS_MANAGER=1`** flips `lib/sync/credentials.ts` from env-var reads to Secrets Manager reads. Same code path for LocalStack (via `AWS_ENDPOINT_URL=http://localhost:4566`) and real AWS.
- Secret name convention: `dante/<env>/<key>` (e.g. `dante/local/personio`).
- Bootstrap via `scripts/seed-secrets.ts` from `.env`.

## Logging

- **`lib/logger.ts`** (JSON-per-line) for **server-side** logs — route handlers, sync, server actions, audit failures. CloudWatch Logs Insights indexes the JSON fields directly.
- **`console.error`** for **client-side** logs (error boundaries in `app/error.tsx`, `app/global-error.tsx`). They land in the browser console, not CloudWatch — no benefit to JSON shape.

## Prod bring-up

Order matters — Terraform creates empty secret containers, but the operator writes the values out-of-band; the ECS service needs an image to pull before it can come up healthy.

1. **Terraform apply (round 1)** — VPC, RDS, ECR, ALB, ACM, DNS, Cognito, secrets containers, sync Lambda. The ECS service starts with 0 healthy tasks because no image is pushed yet. Tasks may flap; that's expected.

2. **Seed Secrets Manager** (one-time, out-of-band):
   ```bash
   # AUTH_SECRET — Auth.js JWT signing key
   aws secretsmanager put-secret-value \
     --secret-id dante/prod/auth_secret \
     --secret-string "$(openssl rand -base64 64)"

   # Personio creds
   aws secretsmanager put-secret-value \
     --secret-id dante/prod/personio \
     --secret-string '{"client_id":"...","client_secret":"..."}'

   # awork creds (post-Phase-B)
   aws secretsmanager put-secret-value \
     --secret-id dante/prod/awork/client \
     --secret-string '{"client_id":"...","client_secret":"..."}'
   # awork/tokens fills itself on first sign-in via /settings/integrations/awork
   ```

3. **Build + push container image**:
   ```bash
   aws ecr get-login-password --region eu-central-1 | docker login --username AWS \
     --password-stdin <repo_url>
   docker buildx build --platform linux/arm64 -t <repo_url>:<git_sha> .
   docker push <repo_url>:<git_sha>
   ```
   `<repo_url>` = `terraform output -raw ecr_repository_url`.

4. **Terraform apply (round 2)** with `-var app_image_uri=<repo_url>:<git_sha>`. ECS rolls the service. Deployment circuit-breaker auto-rolls back on failed health checks.

5. **Confirm SNS subscription emails** — the sync Lambda's alarm topic and any others land in `admin@example.com`. Click the confirm link or alarms won't fire.

6. **First sign-in** — Cognito sends a temp-password email to seed admins; you complete first sign-in, set a permanent password, then enroll MFA on `/auth/mfa/setup`.

For ongoing redeploys (image rebuild + new SHA), step 3 + step 4 are enough — the rest is one-time.

## Credential rotation

Rotate quarterly, plus immediately on any suspected exposure. Order matters — the sync needs both old and new credentials to roll over without downtime.

**Personio (`PERSONIO_CLIENT_ID` / `PERSONIO_CLIENT_SECRET`)**
1. Personio admin generates a new OAuth client in the Personio settings.
2. Update Secrets Manager: `aws secretsmanager put-secret-value --secret-id dante/<env>/personio --secret-string '{"client_id":"...","client_secret":"..."}'`.
3. Update local `.env` for dev.
4. Run a sync once to confirm; revoke the old Personio client.

**awork client (`AWORK_CLIENT_ID` / `AWORK_CLIENT_SECRET`)**
1. Create a new client in awork OAuth settings.
2. Update Secrets Manager `dante/<env>/awork/client`.
3. Re-authorize via `/settings/integrations/awork` (new client = fresh token pair).
4. Revoke the old client in awork.

**awork tokens (`AWORK_ACCESS_TOKEN` / `AWORK_REFRESH_TOKEN`)** — auto-rotate on every sync. Manual rotation only needed if the refresh token is leaked: hit `/settings/integrations/awork` → Authorize.

**`AUTH_SECRET` (Auth.js JWT signing key)**
1. Generate a new value: `openssl rand -base64 64`.
2. Update Secrets Manager `dante/<env>/auth_secret`.
3. Update local `.env`.
4. Restart the app — this invalidates every active session, so all users sign in again. Coordinate with active users or do it after-hours.

## Things deliberately deferred

- **Hooks vs server queries.** Every entity has a TanStack hook and a server-side query helper. Most pages prefetch on the server, so hooks only earn their keep where client refetch matters. Drop hooks per-feature when you touch a page — not in bulk.
- **Large file splits.** `lib/db/_monthly-helpers.ts` (~1088), `components/project/project-monthly-breakdown.tsx` (~740), `lib/sync/awork/housekeeping.ts` (~725), `components/consultant/consultant-monthly-breakdown.tsx` (~591). Split per-feature when next touched (KPI cards out, calc helpers out, table rendering out). Not worth a dedicated refactor pass.
- **Untyped `db.execute()` reads** (60+ sites use `as Array<Record<string, unknown>>`). The write path is now typed Drizzle (column-rename safe at compile time); the read path catches issues at the next page render rather than runtime. Migrate per-route when touched, not in bulk.
- **`awork/housekeeping.ts` minor UPDATEs.** The high-drift INSERTs (customer, project, awork_company_link, awork_project_link) are typed Drizzle; the targeted `UPDATE … SET col = $1 WHERE id = $2` statements stayed as raw SQL because the drift risk is small and the conversion adds noise.
