# Dante

> *Lasciate ogne speranza, voi ch'intrate.* — Inferno, Canto III

Welcome to time tracking. Mind the gap between your ambitions and your
billable hours.

Dante is the internal HR + time-tracking analytics tool for **the original operator**. It pulls employee records, salaries, absences, and attendances
from Personio, marries them to time entries from awork, and gives managers
the numbers they need to run a consultancy without spreadsheets that lie.

It is named after the poet who wrote about descending through nine circles
of progressively worse predicaments. If you have ever filled out a timesheet,
the analogy will land.

---

## What it does

- **Pulls** employee data, compensation history, absences, and project
  attendances from the Personio API. Stale absences (withdrawn or
  rejected after Personio dropped them from the feed) get cleaned up
  on every run.
- **Pulls** companies, users, projects, and time entries from the awork API.
- **Reconciles** the two — links awork users to both Personio employees
  and external freelancers by email, links awork companies to internal
  customers by name, derives consultant assignments from logged time.
- **Records** the bits Personio doesn't track: monthly freelancer hours
  per project (entered by the project's SDM, auto-filled from awork
  when a freelancer happens to log there too) and per-project SDM
  grants. Freelancer hours drive actuals-based cost; absent an entry
  the calc falls back to planned allocation.
- **Knows** the German working calendar per employee: federal +
  state-specific holidays resolved from the employee's office (Bavaria
  gets Fronleichnam, BW/Bayern/Sachsen-Anhalt get Heilige Drei Könige,
  etc.), so per-month billable days and per-month cost reflect what
  the employee actually owes.
- **Shows** the consequences in three roles plus one per-project capability:
  - **Employees** see their own profile, the team allocation calendar
    (with absences shown as the generic "absence", no daily rates),
    and a directory of colleagues (without HR-sensitive fields like
    contract end dates or role tier).
  - **Service Delivery Managers** are employees who have been granted
    SDM rights on one or more specific projects via `project_sdm`.
    They get manager-equivalent access to *their* projects — assignments,
    rates, freelancer hours, Personio/awork links, monthly P&L,
    over-budget alerts — but nothing about other projects.
  - **Managers** see all project economics, portfolio margins,
    consultant utilization, the real Personio absence type
    (including sickness — they need it for planning), salary bands,
    and gender-gap analysis.
  - **Admins** grant and revoke SDM rights, invite users, change
    roles, audit access, re-authorize awork OAuth, and run the
    breakglass migrations.

If you are looking for the spreadsheet version of this, the spreadsheet
version of this is wrong. That's why this exists.

---

## Architecture, at altitude

```
                         Internet
                            │
                            ▼
                     Route 53 / ACM
                            │
                            ▼
                          WAFv2
                            │
                            ▼
                          ALB (443)
                            │
            ┌───────────────┴───────────────┐
            ▼                               ▼
        ECS Fargate                     ECS Fargate
        (Next.js)                       (Next.js)
            │                               │
            └───────────────┬───────────────┘
                            ▼
                    RDS PostgreSQL 16
                            ▲
                            │
              ┌─────────────┴─────────────┐
              ▼                           ▼
        Sync Lambda                  Cognito OIDC
        (06:00 UTC)                  (sign-in + MFA)
              │
   ┌──────────┴──────────┐
   ▼                     ▼
 Personio API         awork API
```

- **Frontend + API:** Next.js 16 (App Router, Server Components, Server
  Actions) on ECS Fargate, ARM64 / Graviton. Two tasks across two AZs.
  A per-request `proxy.ts` issues a CSP nonce + gates unauthenticated
  routes before the app sees them.
- **Database:** RDS PostgreSQL 16, single-AZ on day-one, Multi-AZ flip
  when traffic justifies it. Master credential rotated into Secrets
  Manager and never seen by the operator.
- **Sync:** A Lambda fires daily at 06:00 UTC, pulls Personio + awork,
  upserts via typed Drizzle inserts, purges audit log entries older than
  30 days. Failures throw, surface as CloudWatch `Errors`, land in an
  SQS DLQ, and trigger SNS alarm emails. The `/settings/sync` button
  reuses the same Lambda via synchronous invoke — the web-app task role
  doesn't hold Personio credentials directly.
- **Auth:** AWS Cognito user pool with hosted UI on the custom domain
  `auth.dante.example.com` (own ACM cert in `us-east-1` per Cognito
  requirement). MFA is mandatory for every user
  (`mfa_configuration = "ON"`); TOTP via any authenticator app. The
  pool runs on the **Plus tier** with Threat Protection set to
  `ENFORCED` — adaptive auth + IP throttling + compromised-credentials
  detection in front of the hosted UI. Auth.js receives the OIDC token
  after Cognito has already enforced the factor; the JWT cookie carries
  the Cognito access + refresh tokens server-side only (never reaches
  the client) for self-service flows.
- **Secrets:** AWS Secrets Manager for Personio creds, awork OAuth client
  + rotating tokens, the Auth.js JWT signing key, and the RDS master
  credential. The app composes connection strings at boot from the
  managed RDS secret; nothing sensitive lives in the task definition or
  CloudWatch. Web-app task role holds awork OAuth tokens (read for
  status UI, write for the callback) and Cognito client secret only;
  Personio creds are exclusive to the sync Lambda. The deploy role's
  Secrets Manager perms are split read-write (only the cognito_client
  secret terraform manages) vs describe-only on everything else.
- **Email:** Cognito invitation / reset / MFA-setup emails route through
  SES from `noreply@dante.example.com` (domain identity verified with
  Easy-DKIM; DKIM CNAMEs in Route 53). SES is in sandbox until AWS
  approves production access — see "What is not available" below.
- **WAF:** Managed rule groups (Common, KnownBadInputs, IpReputation,
  SQLi) plus rate limits on `/api/auth/*` (100/5min) and globally
  (2000/5min). Optional geo allow-list.
- **Observability:** App audit rows mirror to CloudWatch as
  `audit_event` log lines; metric filters + alarms fire on spikes in
  `view_inspect_payload` (Personio raw data reads) and `view_salary`
  reads. Alarm SNS topic is the same one the sync Lambda uses.
- **State backend:** Terraform state lives in S3 (`dante-tfstate`,
  versioned + SSE-AES256 + TLS-only bucket policy + public-access
  block) with DynamoDB-backed state locking. The bootstrap stack that
  creates them is the only one with local state. Both GitHub Actions
  and the operator's laptop share the same state file.
- **Region:** `eu-central-1` (Frankfurt). Region-locked at the
  Terraform variable layer — overriding requires legal review.

Operational conventions, including role hierarchy, secret rotation
runbooks, the prod bring-up sequence, and the MFA reset path, live in
[`frontend/AGENTS.md`](frontend/AGENTS.md).

---

## Repository layout

```
frontend/        # Next.js 16 app + sync layer + Drizzle schema
terraform/       # IaC: 10 modules + dev/prod/local environments
docker-compose.yml   # Local Postgres + LocalStack
.env.example     # Required + optional environment variables (not committed)
```

---

## Local development

```bash
# 1. Bring up Postgres + LocalStack
docker compose up -d

# 2. Frontend
cd frontend
npm install
cp ../.env.example ../.env   # fill in Personio + awork creds
npm run dev

# 3. (Optional) run the sync against your local DB
npm run sync
```

Sign in at `http://localhost:3000/login` with any email — dev mode mints
sessions without checking passwords. Roles come from
`AUTH_DEV_ADMIN_EMAILS` / `AUTH_DEV_MANAGER_EMAILS` in `.env`.

Useful npm scripts:
- `npm run check` — type-check + read-only guard on the awork integration
- `npm run sync` — full pull of Personio + awork
- `npm run build:sync-lambda` — bundle the sync Lambda zip
- `npm run check:awork-readonly` — fails if any code outside `lib/sync/awork/auth.ts` issues a POST to awork

---

## Deploying to AWS

The full bring-up runbook (with apply-order, secret-seeding, and image
push) is in [`frontend/AGENTS.md`](frontend/AGENTS.md#prod-bring-up).
Cliff notes:

1. `cd frontend && npm run build:sync-lambda` (produces the zip the
   Terraform module references).
2. `cd terraform/envs/prod && terraform apply` brings up VPC, RDS,
   Cognito, secrets, ECR, ALB, ACM, DNS, sync Lambda, WAF — but the ECS
   service starts with zero healthy tasks because the image hasn't been
   pushed yet.
3. Seed Secrets Manager (`AUTH_SECRET`, Personio creds, awork client).
4. Build + push the container image to ECR.
5. `terraform apply -var app_image_uri=<repo>:<sha>` rolls the service.
6. Confirm SNS subscription emails for the alarm topics.

### Cost

Steady-state monthly cost in `eu-central-1` is roughly **€75 – €85**.
Biggest line items: the two Fargate tasks (~€40/mo combined for the
default 0.5 vCPU / 1 GB sizing), the ALB (~€18/mo), the two interface
VPC endpoints — `kms` + `secretsmanager` — across both AZs (~€38/mo
combined), and the NAT instance (~€3/mo on `t4g.nano`). Cognito Plus
tier adds ~€2/mo at 40 MAU. Everything else (RDS `db.t4g.micro`,
ECR, Secrets Manager containers, Route 53 zone, CloudWatch logs at
retention, SES, SNS, S3 state) totals well under €10/mo.

**Cost assumptions** baked into the current setup, each of which is a
deliberate trade and a future lever if you need to cut further:

- **NAT Gateway today; NAT instance available** (`vpc.nat_mode =
  "instance"`) — switching saves ~€30/mo but requires a non-Free-Tier
  ARM instance type that the AWS 2025 Free Plan blocks
  (`InvalidParameterCombination: The specified instance type is not
  eligible for Free Tier`). The terraform variable is plumbed; flip
  it once IT upgrades the billing tier. NAT instance is single-AZ,
  single-instance — if it dies, the next `terraform apply` rebuilds
  it (~5 min of NAT-dependent outbound disrupted).
- **Single-AZ NAT** for both modes — one NAT in `eu-central-1a`, both
  app AZs route through it. AZ outage on `1a` means no outbound from
  either AZ. Toggle `vpc.single_nat_gateway = false` if multi-AZ
  outbound is required.
- **Two interface endpoints (`kms` + `secretsmanager`) in both AZs**,
  not the four originally provisioned. `logs` and `sts` were dropped
  — call volumes are too small to repay the ~€19/mo each. Both
  removed services now flow through the NAT.
- **Two AZs for the kept endpoints** instead of one. AZ-halving would
  save another ~€19/mo but means one specific AZ failure briefly
  breaks KMS / Secrets-Manager calls until traffic re-routes through
  NAT. Documented here as a deferred lever.
- **Single Fargate task** instead of two-task HA would save another
  ~€20/mo. Not done yet — the ECS deployment circuit breaker still
  catches failed rollouts on a single task, but you'd see ~30-60s
  unavailability during each deploy and zero HA against a task crash.
  Worth considering for stretch-cost runs.
- **CloudWatch log retention** caps app logs at 7 days, audit logs
  at 30 days (see migration 0014). Keep an eye on the log group size
  if `DANTE_LOG_LEVEL` is ever set to `debug` in prod.

### What is *not* available right now (AWS account state, June 2026)

The account this stack is deployed to is in two restrictive states at
once: AWS's 2025 Free Plan (gates several billed services) and SES's
default sandbox mode (gates outbound email). Both lift the moment the
appropriate request is approved by AWS, but until then the following
functionality is degraded or missing from production:

**Data durability and recovery**
- **No automated database backups.** RDS rejects
  `backup_retention_period > 0` under the Free Plan, so the prod DB
  has `backup_retention_days = 0`. There are no daily snapshots, no
  point-in-time recovery, no transaction-log retention. The only way
  to recover from data corruption, an erroneous `DELETE`, or an
  accidental schema migration is to **restore from a manual snapshot**
  taken before the incident. If no manual snapshot exists, the data is
  gone. **Do not load real employee or salary data into prod until
  this is restored.**

**Email deliverability**
- **SES is in sandbox**, so Cognito invitation / password-reset / MFA
  setup emails only reach addresses that have been individually
  pre-verified as SES identities. New hires invited via
  `/settings/users` do not receive their welcome email — the action
  succeeds at the API layer but SES silently drops delivery. The
  workaround is to verify each new email address as an SES identity
  in the AWS console before inviting, or — properly — open the
  SES production-access request. Once approved, the sandbox restriction
  lifts and every recipient gets mail.

**Runtime safety nets**
- **No concurrency cap on the sync Lambda**
  (`reserved_concurrent_executions = -1`). The Free Plan caps
  account-wide unreserved concurrency below AWS's 10-execution floor
  required to reserve, so we'd be denied if we set it. The sync runs
  once a day so contention is rare, but a runaway invocation could in
  principle exhaust RDS connections.

**CI / CD safety nets**
- **No CVE scan gate on container images.** Images deploy to prod
  without a vulnerability scan
  (`SCAN_GATE_ENABLED: "false"` in `.github/workflows/deploy.yml`).
  ECR basic scanning doesn't support arm64 / Graviton, and Inspector
  v2 enhanced scanning needs a Free-Plan-blocked subscription
  (`SubscriptionRequiredException` on `inspector2:Enable`).

**Cost optimisations blocked by Free Plan**
- **NAT instance** (`vpc.nat_mode = "instance"`) — saves ~€30/mo over
  NAT Gateway but needs a non-Free-Tier instance type. The Free Plan
  rejects `RunInstances` for anything outside `t2.micro` /
  `t3.micro`, both x86. Plumbed in terraform but defaulted off until
  the billing tier lifts.

**What is *not* affected**
- WAF, IAM, KMS, Secrets Manager, ALB, Cognito itself, ECR pushes,
  ECS deploys, Route 53, ACM, CloudWatch, SNS — all unaffected.
- App-side functionality is unaffected. Users that *do* receive their
  invitation email can sign in, enroll TOTP, and use the app
  end-to-end exactly as designed.

**How to re-enable**
- Free Plan items are marked `TODO(free-plan)` in
  `terraform/envs/prod/main.tf` or carry long-form notes in the deploy
  workflow. Flipping each back is mechanical once IT upgrades the
  billing tier — see the inline comments for the exact recipes.

---

## License

Proprietary. See [`LICENSE.md`](LICENSE.md).
