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

### Who's who

- **employee** — every regular member of the company, including **team leads**. Team-lead is a project-contribution attribute (`employee_annotation.is_project_contributing`), not a role tier. Team leads use the same UI as anyone else: their own profile, the allocation calendar, the employee list (no detail).
- **manager** — **C-level** (CEO, CFO, COO). Full-org visibility on everything financial: portfolio economics, salary bands, gender-gap analysis, per-employee economics. Required MFA. Three to five people in a 40-person org.
- **admin** — usually one person; manages users + audit log + integrations. Required MFA. Disjoint from "manager" in practice but admins automatically inherit manager-level data access via `ROLE_RANK`.

### Per-role endpoint matrix

- **employee**: `/calendar`, `/profile`, `/employees` (list only), `/api/calendar`, `/api/employees`, `/api/employees/teams`.
- **manager** adds: `/api/portfolio/*`, `/api/salary/*`, `/api/projects/*`, `/api/employees/[id]` (detail), `/api/employees/[id]/salary-history`, `/api/employees/[id]/monthly*`, `/api/employees/[id]/allocations`, `/api/inspect/[employee_id]`, `/api/freelancers/*`, `/api/awork-*`, `/api/tracked-hours`.
- **admin** adds: `/settings/*`, `/api/config`, `/auth/awork/*`.

### Accepted risk: manager has full-org per-employee access

A C-level manager can read **any** employee's salary history, monthly economics, and (post-redaction) Personio attributes. There is **no team scoping** because there are no team-tier managers in this org — the manager role is by definition org-wide. This was flagged as H-001 in the pre-launch pen test and is **accepted as design**.

Compensating controls:
- **MFA required** on every manager account, in-app gated by `requireSession` / `requireApiSession`.
- **Audit log** on every sensitive read: `view_employee_detail`, `view_inspect_payload`, `view_salary_bands`, `view_gender_gap`, `view_salary`. Forensic queries: `SELECT actor_email, COUNT(*) FROM app_audit_log WHERE action IN ('view_inspect_payload','view_employee_detail') AND occurred_at > NOW() - INTERVAL '7 days' GROUP BY actor_email ORDER BY 2 DESC` highlights outliers.
- **Personio payload redaction** in `/api/inspect/*` — IBAN / BIC / bank / tax_id / SSN / passport / national_id / health_insurance / religion / ethnicity attributes return `"[redacted]"`.
- **CloudWatch alarm candidate**: spike in `view_inspect_payload` per actor over a 5-minute window. Not yet wired; would require shipping audit rows to CloudWatch via a sync-time export or a stream.

If the org structure changes (e.g. adding a "team-tier manager" role between manager and employee), revisit this and add team-scoped variants of the per-employee endpoints. Until then, the audit log is the primary control and must stay queryable.

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

2. **Seed Secrets Manager** (one-time, out-of-band — *not* via GitHub).

   All app secrets live in AWS Secrets Manager. GitHub Actions never
   holds any app secret; the deploy workflow assumes an IAM role via
   OIDC and the ECS task definition injects the values straight from
   Secrets Manager as env vars at container start. The only thing in
   the GitHub repo is the deploy-role ARN (a *variable*, not a secret —
   useless without the OIDC trust policy that Terraform created).

   Secret matrix:

   | Secret container | Filled by | Rotation |
   |---|---|---|
   | `dante/prod/auth_secret` | Manual `put-secret-value` with `openssl rand -base64 64` | Only on suspected compromise |
   | `dante/prod/personio` | Manual `put-secret-value` with the JSON Personio's portal gave you | When Personio admin rotates the API client |
   | `dante/prod/awork/client` | Manual `put-secret-value` with the awork OAuth client_id (+ optional secret) | Rare |
   | `dante/prod/awork/tokens` | **Auto** — first sign-in as admin → `/settings/integrations/awork` → click *Authorize*; the OAuth callback writes the tokens. Every `npm run sync` thereafter refreshes them in place. | Never manually |
   | `dante-prod-rds-master-…` (RDS-managed) | RDS auto-generates on first apply, KMS-encrypted; ECS reads via the task definition `secrets:` block | Auto-rotation via `aws secretsmanager rotate-secret`; force-new-deployment on the service afterwards |

   Commands for the three manual ones:
   ```bash
   # AUTH_SECRET — Auth.js JWT signing key
   aws secretsmanager put-secret-value \
     --secret-id dante/prod/auth_secret \
     --secret-string "$(openssl rand -base64 64)"

   # Personio creds
   aws secretsmanager put-secret-value \
     --secret-id dante/prod/personio \
     --secret-string '{"client_id":"papi-...","client_secret":"papi-..."}'

   # awork OAuth client (Phase B)
   aws secretsmanager put-secret-value \
     --secret-id dante/prod/awork/client \
     --secret-string '{"client_id":"...","client_secret":"..."}'
   ```

   The RDS master credential and `dante/prod/awork/tokens` are
   deliberately omitted — both are populated by their respective
   automated paths, not by hand.

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

## CI / CD (GitHub Actions)

Two workflows + two OIDC roles. No long-lived AWS keys.

**`.github/workflows/check.yml`** — runs on every PR + push outside `main`:
- Type-check (`npm run check`) + awork read-only guard + builds the migrate runner and sync Lambda bundle (catches build-pipeline drift).
- `terraform fmt -check -recursive` over the whole tree + `terraform init -backend=false && validate` against each env.
- `hadolint` against `frontend/Dockerfile` (errors only — style warnings don't block).

**`.github/workflows/deploy.yml`** — runs on push to `main`:
1. **build**: assume the deploy role via OIDC, ECR login, `docker buildx` arm64 build + push tagged with the first 12 chars of the commit SHA. Then rebuild the sync Lambda zip and upload as a workflow artifact.
2. **terraform**: download the Lambda artifact, `terraform plan` (passing `app_image_uri` + `github_repository` + `hosted_zone_id`), `terraform apply` the plan.
3. **rollout**: `aws ecs update-service --force-new-deployment` + `aws ecs wait services-stable`. The task definition already moved during the Terraform step; this triggers the service to roll.

**Repository configuration (one-time after first `terraform apply`)** — set as repository **variables** (ARNs aren't secrets). The repo's GitHub Secrets are deliberately empty for app config — all app secrets live in AWS Secrets Manager and the runtime reads them directly; see [Prod bring-up §2](#prod-bring-up).
- `AWS_DEPLOY_ROLE_ARN` ← `terraform output -raw github_deploy_role_arn`
- `AWS_CHECK_ROLE_ARN`  ← `terraform output -raw github_check_role_arn`
- `ECS_CLUSTER_NAME`    ← `terraform output -raw app_cluster_name`
- `ECS_SERVICE_NAME`    ← `terraform output -raw app_service_name`
- `HOSTED_ZONE_ID`      ← the Route 53 zone ID for the parent domain

**The chicken-and-egg**: the deploy workflow assumes the deploy role, but Terraform created it. First apply runs from a developer's laptop with admin credentials. After that, GitHub takes over.

**Branch protection**: the deploy role's trust policy is scoped to `ref:refs/heads/main`. A feature branch attempting to assume the deploy ARN is denied at STS — no risk of feature-branch deploys to prod.

## Boot-time migrations

The container's `entrypoint.sh` runs `node /app/migrate.js` before `exec`ing the Next.js server. Migrations are idempotent (advisory-locked by Drizzle); multiple ECS tasks starting concurrently serialize automatically.

A migration failure exits the container, fails the ECS health check, triggers the deployment circuit-breaker's auto-rollback. This is intentional — better a failed deploy than serving traffic against a partly-migrated schema.

**Emergency override**: `DANTE_SKIP_MIGRATIONS=1` on the task definition boots without running migrations. Use only when a migration is the suspect.

**Adding a migration**:
1. Edit `frontend/lib/db/schema/*.ts`.
2. `cd frontend && npx drizzle-kit generate` produces a new SQL file under `lib/db/migrations/` + updates `meta/_journal.json`.
3. Commit. The next deploy applies it on boot.

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

**RDS master credential (`DB_USERNAME` / `DB_PASSWORD`)**
RDS-managed rotation writes the new credential into Secrets Manager but does NOT signal running ECS tasks. Env vars in a running task are frozen at boot — they keep using the old password until the task is replaced. An attacker with RCE who captured the old password before rotation can still connect to RDS for the lifetime of the task (was H-007 in the pre-launch pen test).

Order matters:
1. `aws secretsmanager rotate-secret --secret-id <rds master secret arn>` (or wait for AWS-scheduled rotation if you wire that in).
2. RDS commits the new password in the DB and pushes it to Secrets Manager.
3. **Immediately roll the ECS service**: `aws ecs update-service --cluster $CLUSTER --service $SERVICE --force-new-deployment` — new tasks pick up the rotated credential from Secrets Manager at boot via the task definition's `secrets:` block.
4. `aws ecs wait services-stable ...` to confirm.

Long-term fix: switch to **RDS IAM database authentication** (the task role generates a 15-minute auth token per connection; nothing to rotate, nothing to leak). Documented as a follow-up — not implemented yet because it requires a small `pg.Pool` wrapper that requests a fresh token before opening a connection.

## npm audit advisories (M-011)

Two open transitive moderate advisories in the prod dependency tree (`npm audit --omit=dev`):
- **next** — sources its own advisory via a Next.js-internal package. `npm audit fix --force` "fixes" this by downgrading to Next.js 9.3.3, which is a regression to a 5-year-old major version. Ignore that suggestion; track upstream patches.
- **postcss** — transitive through `next`. Fixes whenever Next bumps its postcss pin.

Both are dev-tooling exposure (PostCSS at build time, Next CLI). Neither affects the running container — `npm ci --production` in CI doesn't install them. Re-check after every Next.js minor bump.

For dev-only advisories (devDependencies — drizzle-kit's `@esbuild-kit/esm-loader`, etc.), the rule is the same: don't downgrade, wait for the upstream fix. Build artifacts run in CI sandboxes, not in production.

**CI policy**: the deploy workflow runs the ECR scan-on-push gate (M-008) which is the actual production CVE check. That gate operates on the built container, not on `package-lock.json`, so it catches real risks regardless of `npm audit` noise.

## Things deliberately deferred

- **Hooks vs server queries.** Every entity has a TanStack hook and a server-side query helper. Most pages prefetch on the server, so hooks only earn their keep where client refetch matters. Drop hooks per-feature when you touch a page — not in bulk.
- **Large file splits.** `lib/db/_monthly-helpers.ts` (~1088), `components/project/project-monthly-breakdown.tsx` (~740), `lib/sync/awork/housekeeping.ts` (~725), `components/consultant/consultant-monthly-breakdown.tsx` (~591). Split per-feature when next touched (KPI cards out, calc helpers out, table rendering out). Not worth a dedicated refactor pass.
- **Untyped `db.execute()` reads** (60+ sites use `as Array<Record<string, unknown>>`). The write path is now typed Drizzle (column-rename safe at compile time); the read path catches issues at the next page render rather than runtime. Migrate per-route when touched, not in bulk.
- **`awork/housekeeping.ts` minor UPDATEs.** The high-drift INSERTs (customer, project, awork_company_link, awork_project_link) are typed Drizzle; the targeted `UPDATE … SET col = $1 WHERE id = $2` statements stayed as raw SQL because the drift risk is small and the conversion adds noise.
