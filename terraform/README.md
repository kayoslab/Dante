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

## AWS Free Plan accounts (prod)

AWS's 2025 Free Plan hard-blocks several settings this stack uses at its safe defaults. Rather than editing `main.tf`, set the single prod variable `aws_free_plan = true` (CI: repository variable `AWS_FREE_PLAN`). It swaps in the degraded variants and nothing else:

| Setting | Paid account | `aws_free_plan = true` | Impact while degraded |
|---|---|---|---|
| `module.rds.backup_retention_days` | `var.rds_backup_retention_days` (7) | `0` | **No automated backups, no point-in-time recovery.** Do not load real employee data. |
| `module.sync_lambda.reserved_concurrent_executions` | `2` | `-1` | No concurrency cap; a runaway sync could exhaust RDS connections. |
| `module.cognito_pretoken_lambda.reserved_concurrent_executions` | `5` | `-1` | Same, on the sign-in path. |
| `aws_inspector2_enabler` + `aws_ecr_registry_scanning_configuration` | created | not created | Images deploy without a CVE scan; the workflow's scan gate is skipped in lockstep. |

Flip it back to `false` once the account is on a paid tier and run `terraform apply`. Verify RDS picked it up with `aws rds describe-db-instances --db-instance-identifier dante-prod --query 'DBInstances[0].BackupRetentionPeriod'` (expect `7`); if it still returns `0`, the account wasn't actually upgraded. The very first CI deploy after flipping should be dispatched with `skip_scan_gate = true`, because the build job's scan gate runs before terraform enables Inspector.

Other Free-Plan symptoms seen during bring-up: `aws rds describe-db-engine-versions` omits recently-retired minor versions (we bumped to 16.14), RDS rejects some optional features with `FreeTierRestrictionError`, and NAT-instance mode (`vpc_nat_mode = "instance"`) can't launch Graviton instance types. The `aws_region` lock to `eu-central-1` in `variables.tf` is unrelated (GDPR).

## Phase P1 (Day 1) — Cognito User Pool only

This applies the smallest possible footprint: one Cognito User Pool, three role groups, one app client, and your seeded admin user. **Estimated cost: €0** at this scale (Cognito free tier covers 50k MAU).

```
cd terraform/envs/dev
terraform init
terraform plan
terraform apply
```

After `apply`:

- Cognito will email each address in `seed_admin_emails` with a temp password. The sender is the default Cognito one (`no-reply@verificationemail.com`) — moves to SES with `noreply@<domain>` in P3.
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
