# Dante infrastructure (Terraform)

## Layout

```
terraform/
  versions.tf              # Terraform + provider version constraints
  envs/
    dev/                   # Dev environment — local state file, single workstation
      backend.tf
      main.tf
      variables.tf
      outputs.tf
      terraform.tfvars     # Per-env values (gitignored). Edit before apply.
      terraform.tfvars.example
    prod/                  # (added in P3) S3 remote state, hardened defaults
  modules/
    cognito/               # User Pool + groups + app client + seed users
```

One module per AWS-shaped concern. Environments compose modules. State is local for `dev/` today; moves to S3 backend when more than one operator provisions.

## Prerequisites

1. **Terraform 1.7+** (`brew install terraform`).
2. **AWS CLI configured** with credentials for the AWS account you want to provision into. Region: `eu-central-1` (Frankfurt — GDPR).
   ```
   aws configure
   ```
   Or use a named profile and export `AWS_PROFILE=<name>` before running.
3. Confirm Terraform sees the right account before applying anything:
   ```
   aws sts get-caller-identity
   ```

## ⚠️ AWS Free Plan workarounds (prod)

The prod AWS account (`000000000000`) was on AWS's 2025 Free Plan at bring-up. The plan hard-blocks two configurations Dante needs at safe defaults, so the prod env temporarily overrides them. Both overrides live in `terraform/envs/prod/main.tf` marked `TODO(free-plan)`:

| Setting | Safe default | Free-Plan override | Impact |
|---|---|---|---|
| `module.rds.backup_retention_days` | `7` | `0` | **No automated backups, no point-in-time recovery.** Do not put real employee data in prod RDS until restored. |
| `module.sync_lambda.reserved_concurrent_executions` | `2` | `-1` | No concurrency reservation. The sync Lambda runs from the account-wide pool; under contention it could exceed the intended 2-in-flight cap on RDS connections. |

**Restoration steps once the account is upgraded:**

1. Confirm IT has attached a billing method and the account is on a paid plan (`aws ce get-cost-and-usage` should succeed without quota errors).
2. Edit `terraform/envs/prod/main.tf`: remove the `TODO(free-plan)` overrides, set `backup_retention_days = 7` and `reserved_concurrent_executions = 2`.
3. `terraform plan` + `terraform apply` from `terraform/envs/prod/`.
4. Verify RDS picked up the change:
   ```
   aws rds describe-db-instances --db-instance-identifier dante-prod \
     --query 'DBInstances[0].BackupRetentionPeriod'
   ```
   Should return `7`. If still `0`, the plan succeeded but the account hasn't actually been upgraded — talk to IT before re-trying.

Other Free-Plan symptoms surfaced during bring-up: the `aws rds describe-db-engine-versions` list excludes recently-retired minor versions (we bumped to 16.14), and RDS rejects some optional features outright with `FreeTierRestrictionError`. The `aws_region` lock to `eu-central-1` in `variables.tf` is unrelated (GDPR), not a Free-Plan effect.

## Phase P1 (Day 1) — Cognito User Pool only

This applies the smallest possible footprint: one Cognito User Pool, three role groups, one app client, and your seeded admin user. **Estimated cost: €0** at this scale (Cognito free tier covers 50k MAU).

```
cd terraform/envs/dev
terraform init
terraform plan
terraform apply
```

After `apply`:

- Cognito will email `admin@example.com` (the seeded admin) with a temp password. The sender is the default Cognito one (`no-reply@verificationemail.com`) — moves to SES with `d.alighieri@dante.example.com` in P3.
- Read the outputs and put them in `frontend/.env`:
  ```
  terraform output cognito_user_pool_id
  terraform output cognito_client_id
  terraform output -raw cognito_client_secret    # sensitive — won't print without -raw
  terraform output cognito_issuer_url
  terraform output cognito_oauth_endpoint
  ```
  Use these as `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`, `COGNITO_CLIENT_SECRET`, `COGNITO_ISSUER`, `COGNITO_OAUTH_ENDPOINT`.

## What the Cognito module configures

- **Sign-in identifier:** email (no usernames to coordinate).
- **Password policy:** 12+ chars, mixed case, digit, symbol. 7-day temp-password validity.
- **MFA:** OPTIONAL at the pool level. Per-role enforcement happens in the app (P1 day 2): admins/managers MUST have TOTP enrolled before they can use admin/manager-scoped routes; employees can opt in.
- **Self-signup:** off. New users only via `AdminCreateUser` (Terraform seed, or `/settings/users` page in the app).
- **Account recovery:** verified email only (no SMS — EU SMS is unreliable and SIM-swap is real).
- **Groups:** `admin` (precedence 1), `manager` (10), `employee` (100). The app reads `cognito:groups` from the JWT and maps to the highest-precedence role.
- **App client:** confidential (server-side Auth.js holds the secret). Auth-code + PKCE flow. Token lifetimes — 1h access/id, 30d refresh.
- **OAuth domain:** Cognito-hosted at `dante-<env>-<random>.auth.eu-central-1.amazoncognito.com`. We use it for the OIDC endpoints, not the Hosted UI — our `/login` is custom.

## Destroying

```
terraform destroy
```

Deletes the pool, groups, client, and all users in it. There is no recycle bin — the user records and any in-app linkage data go away. For prod we'll set `prevent_destroy = true` on the pool resource.

## Roadmap

- **P1 Day 2+:** wire Auth.js to this pool, build `/login`, role enforcement everywhere.
- **P2:** LocalStack for Secrets Manager + Lambda + EventBridge. Cognito stays on real AWS (LocalStack Free doesn't cover it; the dev pool is essentially free anyway).
- **P3:** prod environment in `envs/prod/`, RDS module, ECS app module, sync-Lambda module, WAF + ALB module, S3 remote state, IAM Identity Center for human access.
- **Later:** add Microsoft Entra ID as an `aws_cognito_identity_provider` to enable O365 sign-in. Zero app code change.
