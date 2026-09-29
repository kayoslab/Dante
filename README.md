# Dante

> *Lasciate ogne speranza, voi ch'intrate.* — Inferno, Canto III

Welcome to time tracking. Mind the gap between your ambitions and your
billable hours.

Dante is an HR + time-tracking analytics tool for consultancies,
released as an open-source example implementation by
[Simon Krüger](https://github.com/kayoslab). It pulls employee records, salaries, absences, and attendances from
Personio, marries them to time entries from awork, and gives managers the
numbers they need to run a consultancy without spreadsheets that lie.

It is named after the poet who wrote about descending through nine circles
of progressively worse predicaments. If you have ever filled out a timesheet,
the analogy will land.

---

## What this repository is

This is a **reference implementation, not a product.** It is offered as a
starting point for organisations with a *dispersed data environment* —
the common situation where the people you employ are recorded in one
system (an HRIS such as Personio), the work they do is recorded in
another (a project or time-tracking tool such as awork), your customers
and rates live in a third place, and nobody has a single view that joins
them. Dante shows one complete, production-grade way to close that gap:

- a scheduled **sync layer** that pulls each source into a normalised
  PostgreSQL schema, with the source-specific quirks isolated behind
  adapters;
- a **reconciliation layer** that links records across systems (people
  by email, customers by name, assignments derived from logged time)
  and lets an operator override the guesses;
- a set of **report engines** (utilisation, bench, project P&L, margin,
  pay-gap) that compute against the reconciled data rather than against
  any one source;
- a **role model** (employee / SDM / manager / admin) that decides who
  may see what, down to individual HR-sensitive fields;
- the **infrastructure** to run it securely on AWS — network, secrets,
  auth with mandatory MFA, WAF, audit logging, alarms — as Terraform.

The concrete integrations (Personio, awork, Cognito, the German
working-calendar rules) reflect the environment it was first built for. If yours
differs, the intended path is to fork this repository, swap the adapter
that doesn't match, and keep the rest. The repository is MIT-licensed
precisely so that you can. See [`CONTRIBUTING.md`](CONTRIBUTING.md) if
you'd like to send improvements back.

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
      (every 6h, UTC)                (sign-in + MFA)
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
- **Sync:** A Lambda fires every 6 hours (04:00 / 10:00 / 16:00 / 22:00 UTC), pulls Personio + awork,
  upserts via typed Drizzle inserts, purges audit log entries older than
  30 days. Failures throw, surface as CloudWatch `Errors`, land in an
  SQS DLQ, and trigger SNS alarm emails. The `/settings/sync` button
  reuses the same Lambda via synchronous invoke — the web-app task role
  doesn't hold Personio credentials directly.
- **Auth:** AWS Cognito user pool with hosted UI on the custom domain
  `auth.<domain>` (own ACM cert in `us-east-1` per Cognito
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
  SES from `noreply@<domain>` (domain identity verified with
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
- `npm run check` — type-check + awork read-only guard + DB-locality guard + tests
- `npm run sync` — full pull of Personio + awork
- `npm run build:sync-lambda` — bundle the sync Lambda zip
- `npm run check:integration-readonly` — fails if any provider adapter issues an HTTP write outside the files it declares in `writesAllowedIn` (awork: only `auth.ts`, the OAuth token endpoint)
- `npm run check:db-locality` — fails if any code outside `lib/db/` opens a `db.execute`/`db.select`/`db.insert`/`db.update`/`db.delete`/`db.transaction` call. API routes, Server Actions and Server Component pages call named query functions from `lib/db/queries/*` only

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

Nothing deployment-specific is checked in — see
[Configuration](#configuration) for every variable CI and terraform
expect.

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

- **NAT Gateway by default; NAT instance available**
  (`vpc_nat_mode = "instance"`) — switching saves ~€30/mo but needs a
  Graviton instance type, which AWS Free Plan accounts cannot launch
  (`InvalidParameterCombination: ... not eligible for Free Tier`). NAT
  instance is single-AZ, single-instance — if it dies, the next
  `terraform apply` rebuilds it (~5 min of NAT-dependent outbound
  disrupted).
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

### Configuration

Deployment-specific values live in two places, never in the tree:
GitHub **repository variables** for CI (Settings → Secrets and variables
→ Actions → Variables), and a gitignored
`terraform/envs/prod/prod.auto.tfvars` (copy the `.example`) for manual
applies. None of them are secrets; all app secrets live in AWS Secrets
Manager.

**GitHub repository variables** (read by `.github/workflows/deploy.yml`)

| Variable | Example | Purpose |
|---|---|---|
| `DEPLOY_ENABLED` | `true` | Explicit opt-in. Every deploy job is skipped unless this is exactly `true`, so forks and mirrors never deploy. |
| `AWS_FREE_PLAN` | `true` / `false` | Whether the AWS account is on the 2025 Free Plan. Drives terraform `aws_free_plan` and the CVE scan gate — see below. |
| `AWS_DEPLOY_ROLE_ARN` | `arn:aws:iam::…:role/dante-prod-gh-deploy` | IAM role CI assumes via OIDC. `terraform output -raw github_deploy_role_arn`. |
| `HOSTED_ZONE_ID` | `Z0123…` | Route 53 zone of the parent domain. |
| `APP_DOMAIN` | `dante.example.com` | Public hostname. Cognito's hosted UI goes on `auth.<APP_DOMAIN>`. |
| `PARENT_DOMAIN` | `example.com` | Corporate parent domain; verified as an SES identity for sandbox delivery. |
| `SEED_ADMIN_EMAILS` | `["admin@example.com"]` | JSON list. First admins invited into Cognito. |
| `SYNC_LAMBDA_ALARM_EMAILS` | `["ops@example.com"]` | JSON list. Sync-alarm SNS subscribers. |
| `WAF_ALARM_EMAILS` | `["ops@example.com"]` | JSON list. WAF-alarm SNS subscribers. |
| `ECS_CLUSTER_NAME` / `ECS_SERVICE_NAME` | `dante-prod-app` | Targets for the post-apply rollout. `terraform output -raw app_cluster_name` / `app_service_name`. |

**Terraform toggles** (`terraform/envs/prod/variables.tf`; all have safe
defaults except the ones CI must supply)

| Variable | Default | What it does |
|---|---|---|
| `aws_free_plan` | `false` | **The Free Plan switch.** `true` degrades three things the Free Plan rejects: RDS automated backups (`backup_retention_period` forced to `0` — no point-in-time recovery, so don't load real employee data), Lambda concurrency reservations (`-1`, no cap), and Inspector v2 enhanced ECR scanning (not created; the workflow's CVE gate is skipped in lockstep). Flip to `false` on a paid account and re-apply — everything reverts. Dispatch the first deploy after flipping with `skip_scan_gate = true`, since the scan gate runs before terraform enables Inspector. |
| `rds_backup_retention_days` | `7` | Backup retention on a paid account. |
| `rds_multi_az` | `false` | Multi-AZ RDS. Flip when traffic justifies it. |
| `vpc_nat_mode` | `gateway` | `instance` saves ~€30/mo but can't launch on Free Plan accounts. |
| `vpc_single_nat_gateway` | `true` | One NAT for all AZs vs one per AZ. |
| `waf_enabled` | `true` | Detach the WAF only for a pentest window. |
| `sync_lambda_schedule_expression` | every 6 h | EventBridge cron for the Personio + awork sync. |
| `domain`, `parent_domain`, `hosted_zone_id`, `github_repository`, `seed_admin_emails`, `sync_lambda_alarm_emails`, `waf_alarm_emails`, `app_image_uri` | *none* | Required; CI passes them from the variables above. |

**One account-level item no variable can fix:** a fresh AWS account has
SES in **sandbox**, so Cognito invitation / reset emails only reach
addresses individually verified as SES identities (or any mailbox on
`PARENT_DOMAIN` once its verification TXT record is published — see the
`ses_parent_domain_verification` terraform output). Request SES
production access in the console; nothing in this repo changes when it
is granted.

---

## Contributing

Issues and pull requests are welcome — see
[`CONTRIBUTING.md`](CONTRIBUTING.md) for the checks to run and the two
architectural guards (awork read-only, DB access local to `lib/db/`)
that CI enforces.

---

## License

Released under the [MIT License](LICENSE.md) by
[Simon Krüger](https://github.com/kayoslab). Copyright (c) 2026 Simon Krüger.
