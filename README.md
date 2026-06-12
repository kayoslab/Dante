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
  Actions) on ECS Fargate. Two tasks across two AZs.
- **Database:** RDS PostgreSQL 16, single-AZ on day-one, Multi-AZ flip
  when traffic justifies it. Master credential rotated into Secrets
  Manager and never seen by the operator.
- **Sync:** A Lambda fires daily at 06:00 UTC, pulls Personio + awork,
  upserts via typed Drizzle inserts, purges audit log entries older than
  30 days. Failures land in an SQS DLQ; CloudWatch alarms publish to
  an SNS topic.
- **Auth:** AWS Cognito user pool with hosted UI. MFA is mandatory for
  every user (`mfa_configuration = "ON"`); the user pool offers both
  TOTP (any authenticator app) and WebAuthn passkeys, scoped to the
  app's domain as the relying party. Auth.js receives the OIDC token
  after Cognito has already enforced the factor.
- **Secrets:** AWS Secrets Manager for Personio creds, awork OAuth client
  + rotating tokens, the Auth.js JWT signing key, and the RDS master
  credential. The app composes connection strings at boot from the
  managed RDS secret; nothing sensitive lives in the task definition or
  CloudWatch.
- **WAF:** Managed rule groups (Common, KnownBadInputs, IpReputation,
  SQLi) plus rate limits on `/api/auth/*` (100/5min) and globally
  (2000/5min). Optional geo allow-list.
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

Steady-state monthly cost in `eu-central-1` is roughly **€135** —
dominated by the always-on NAT gateway, the four interface VPC
endpoints, and two Fargate tasks.

---

## License

Proprietary. See [`LICENSE.md`](LICENSE.md).
