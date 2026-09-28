/**
 * Prod environment.
 *
 * Module wiring:
 *   vpc       — networking foundation; outputs subnets + SG
 *   secrets   — Personio + awork credential containers
 *   rds       — Postgres in the data subnets, managed master credential
 *   cognito   — User pool (admin / manager / employee groups)
 *   sync_lambda — Scheduled sync, lives in the app subnets, reads secrets
 *                 + the RDS managed credential
 *
 * Apply order on first run:
 *   1. cd terraform/envs/prod
 *   2. (from frontend/) npm run build:sync-lambda   ← produces the zip
 *   3. terraform init
 *   4. terraform plan -out=prod.tfplan
 *   5. Review the plan diff — pay close attention to:
 *      - VPC CIDR (collides with on-prem?)
 *      - RDS storage size + instance class
 *      - seed_admin_emails (becomes Cognito invites with real emails)
 *      - Cognito callback / domain
 *   6. terraform apply prod.tfplan
 *   7. Note the SNS email confirmations land in alarm_email_addresses —
 *      each subscriber clicks the link before the alarms can publish.
 *   8. Pull outputs into the future ECS task definition via
 *      `terraform output -raw <name>`.
 */

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      App         = "dante"
      Environment = "prod"
      ManagedBy   = "terraform"
      DataClass   = "gdpr-personal"
    }
  }
}

# Cognito requires ACM certs for custom user-pool domains to live in
# us-east-1 specifically (no exceptions, regardless of where the pool
# itself is). Only used for the `auth.<domain>` cert below
# — every other resource stays in eu-central-1.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = {
      App         = "dante"
      Environment = "prod"
      ManagedBy   = "terraform"
      DataClass   = "gdpr-personal"
    }
  }
}

module "vpc" {
  source = "../../modules/vpc"

  environment        = "prod"
  name_prefix        = "dante"
  cidr_block         = var.vpc_cidr_block
  az_count           = var.vpc_az_count
  single_nat_gateway = var.vpc_single_nat_gateway
  nat_mode           = var.vpc_nat_mode
  # Flow logs off by default; flip after onboarding traffic for incident
  # response baselines.
  enable_flow_logs = false

  # Endpoint policies pin every interface endpoint to the current AWS
  # account at minimum — an RCE'd workload can't reach Secrets Manager
  # / KMS / Logs / STS in another account through these endpoints (was
  # M-002 in the pre-launch pen test). Tighter per-role scoping is a
  # follow-up; needs the role ARNs from the app + sync_lambda modules
  # and is best applied via a second pass using `aws_vpc_endpoint_policy`
  # to break the module dependency cycle.
  endpoint_policies = {
    secretsmanager = local.account_scoped_endpoint_policy
    kms            = local.account_scoped_endpoint_policy
    logs           = local.account_scoped_endpoint_policy
    sts            = local.account_scoped_endpoint_policy
  }
}

locals {
  account_scoped_endpoint_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = "*"
      Action    = "*"
      Resource  = "*"
      Condition = {
        StringEquals = {
          "aws:PrincipalAccount" = data.aws_caller_identity.current.account_id
        }
      }
    }]
  })
}

module "cognito" {
  source = "../../modules/cognito"

  environment       = "prod"
  name_prefix       = "dante"
  seed_admin_emails = var.seed_admin_emails
  domain_name       = var.domain

  callback_urls = [
    "https://${var.domain}/api/auth/callback/cognito",
  ]
  logout_urls = [
    "https://${var.domain}",
  ]

  # Custom Cognito hosted-UI domain. WebAuthn passkeys are bound to an
  # RPID (relying party ID) that must be a registrable suffix of the
  # browser's current page origin. Passkeys registered against the app
  # at `var.domain` can only be used at sign-in if the hosted
  # UI lives on the same eTLD+1. The default `*.amazoncognito.com`
  # domain is on a different eTLD+1 and breaks WebAuthn.
  custom_domain_name     = "auth.${var.domain}"
  custom_domain_cert_arn = aws_acm_certificate_validation.cognito_custom.certificate_arn

  # Passkeys / WebAuthn — OFF (rolled back). Flipping this false derives
  # mfa_configuration = "ON" (Cognito-enforced TOTP for everyone),
  # removes WEB_AUTHN from the first-auth factors, and drops the WebAuthn
  # RP config — restoring the original pentest-hardened posture. Kept the
  # module capability + rpId wired so re-enabling is a one-line flip.
  #
  # Why off: with everything configured per AWS docs (Plus tier,
  # WEB_AUTHN in first-auth factors, ALLOW_USER_AUTH, Managed Login v2,
  # branding), Cognito Managed Login still never surfaced the passkey
  # option and InitiateAuth(USER_AUTH) never offered WEB_AUTHN. Prod was
  # sitting on the weaker mfa=OPTIONAL posture with no passkey payoff
  # mid-pentest, so we reverted. Passkeys to be pursued on a dev pool +
  # AWS support before re-enabling. MUST move in lockstep with
  # DANTE_PASSKEYS_ENABLED below.
  web_authn_enabled          = false
  web_authn_relying_party_id = var.domain

  # SES sender. Without this Cognito falls back to its default sender
  # (`no-reply@verificationemail.com`), which is rate-limited to ~50/day
  # and routinely spam-filtered by corporate inboxes — invite + reset
  # mails just don't arrive. We send from `noreply@<var.domain>` so
  # DKIM + DMARC align with a domain we control.
  ses_source_arn         = aws_sesv2_email_identity.dante.arn
  ses_from_email_address = "Dante <noreply@${var.domain}>"

  # Cognito Plus tier — adaptive auth + compromised-creds detection.
  # ~$2/mo at our scale, defensive in depth in front of the hosted UI
  # (which is the only Cognito surface a pen-tester / attacker can hit).
  # Threat Protection requires `user_pool_tier = PLUS`.
  user_pool_tier         = "PLUS"
  advanced_security_mode = "ENFORCED"

  # Agent integration. The callback URL(s) point to the EVE deploy.
  # `pre_token_generation_lambda_arn` plugs in the Lambda that subsets
  # `dante-agents/*` scopes per the user's Cognito group.
  agent_client_callback_urls      = var.agent_callback_urls
  agent_client_logout_urls        = var.agent_callback_urls
  pre_token_generation_lambda_arn = module.cognito_pretoken_lambda.function_arn
}

# Pre Token Generation Lambda. Independent of the cognito module so we
# can resolve the otherwise-circular dependency between the two: the
# pool needs the Lambda ARN, the Lambda's invoke-permission needs the
# pool ARN. Module = Lambda + IAM only; the permission lives below at
# the env level so both module outputs are available.
module "cognito_pretoken_lambda" {
  source = "../../modules/cognito-pretoken-lambda"

  environment         = "prod"
  name_prefix         = "dante"
  package_zip_path    = var.cognito_pretoken_lambda_package_zip_path
  package_source_hash = filemd5(var.cognito_pretoken_lambda_package_zip_path)

  # -1 disables the reservation on Free Plan accounts for the same
  # reason the sync Lambda does (see `var.aws_free_plan`).
  reserved_concurrent_executions = var.aws_free_plan ? -1 : 5

  # Reuse the sync Lambda's alarm topic — same SNS subscription
  # already routes to the admin email. Separate topic per Lambda
  # would just double the inbox noise for no operational benefit.
  alarm_sns_topic_arn = module.sync_lambda.alarm_topic_arn
}

# Cognito → Lambda invoke permission. Pinned to the specific pool's
# ARN so even an unrelated pool in the same account can't trigger
# this Lambda.
resource "aws_lambda_permission" "cognito_pretoken_invoke" {
  statement_id  = "AllowCognitoUserPoolInvoke"
  action        = "lambda:InvokeFunction"
  function_name = module.cognito_pretoken_lambda.function_name
  principal     = "cognito-idp.amazonaws.com"
  source_arn    = module.cognito.user_pool_arn
}

# SES sender identity for Cognito invitation / reset / verification
# emails. Domain identity (covers any address on the domain). Cognito
# is regional, so SES must be in the same region as the user pool.
resource "aws_sesv2_email_identity" "dante" {
  email_identity = var.domain
  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }
}

# Easy-DKIM CNAMEs. SES generates exactly 3 selector tokens per identity;
# each needs a CNAME pointing into amazonses.com. Without these, SES
# refuses to send because the identity stays in "Pending" verification.
# count=3 is hard-coded because the token list is apply-time-only —
# for_each can't enumerate it. The selector count is a stable SES API
# contract (RSA_2048 always emits 3).
resource "aws_route53_record" "ses_dkim" {
  count   = 3
  zone_id = var.hosted_zone_id
  name    = "${aws_sesv2_email_identity.dante.dkim_signing_attributes[0].tokens[count.index]}._domainkey.${var.domain}"
  type    = "CNAME"
  ttl     = 600
  records = ["${aws_sesv2_email_identity.dante.dkim_signing_attributes[0].tokens[count.index]}.dkim.amazonses.com"]
}

# SPF for the sending subdomain. Authorizes SES as a sender for
# `var.domain`. Cognito's default envelope (MAIL FROM) is an
# amazonses.com address, so DMARC alignment is carried by DKIM (above),
# not SPF — but publishing SPF is standard hygiene and lets receivers
# that check the header From domain see an explicit authorization.
# `~all` (softfail) rather than `-all` so a stray legitimate path isn't
# hard-rejected; nothing else sends from this subdomain today.
resource "aws_route53_record" "spf" {
  zone_id = var.hosted_zone_id
  name    = var.domain
  type    = "TXT"
  ttl     = 600
  records = ["v=spf1 include:amazonses.com ~all"]
}

# DMARC policy for the sending subdomain. Legitimate mail passes via
# DKIM alignment (SES Easy-DKIM signs d=<var.domain>, which
# matches the From domain); this record tells receivers to quarantine
# anything claiming to be from `var.domain` that isn't
# authenticated. `p=quarantine` is the prudent strong policy for a
# dedicated transactional subdomain that only sends through SES — tighten
# to `p=reject` once comfortable. No `rua` to avoid a cross-domain
# report-authorization record in the corporate parent zone.
resource "aws_route53_record" "dmarc" {
  zone_id = var.hosted_zone_id
  name    = "_dmarc.${var.domain}"
  type    = "TXT"
  ttl     = 600
  records = ["v=DMARC1; p=quarantine"]
}

# Recipient-domain verification for the corporate PARENT domain.
#
# We do NOT send from the parent domain (`var.parent_domain`) — Dante
# sends from the dedicated subdomain `var.domain` (identity + DKIM above). This identity
# exists purely so that, while the SES account is in the sandbox, every
# mailbox on the parent domain counts as a *verified destination*. Without it,
# the sandbox's "verified recipients only" rule blocks Cognito from ever
# delivering an invite/reset to a staff mailbox (only the subdomain is
# verified today, and no employee has an address on the app subdomain).
#
# Because we only need ownership proof — not sending — we use the classic
# single-TXT verification (SESv1 aws_ses_domain_identity) rather than the
# DKIM-CNAME flow. IT publishes ONE TXT record; no DKIM, no SPF/DMARC
# changes to the corporate zone, and no interaction with the existing
# corporate mail auth (MX / SPF / DKIM stay untouched — the
# _amazonses.<parent_domain> name is used only by SES for ownership).
#
# The parent zone is NOT managed by this Terraform (corporate IT
# owns it), so Terraform creates only the identity here; the verification
# record is surfaced via the `ses_parent_domain_verification` output for
# IT to publish. Until that TXT resolves the identity sits "pending" and
# has no effect — creating it is inert and free.
#
# Once verified, this whole block can be removed if the account leaves the
# SES sandbox (production access makes recipient verification moot).
resource "aws_ses_domain_identity" "parent_domain" {
  domain = var.parent_domain
}

# ACM cert for the Cognito custom domain. MUST be in us-east-1
# regardless of the rest of the stack's region (Cognito requirement).
resource "aws_acm_certificate" "cognito_custom" {
  provider          = aws.us_east_1
  domain_name       = "auth.${var.domain}"
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Name = "auth.${var.domain}"
  }
}

# DNS validation records for the ACM cert. Route 53 is global, so the
# default (eu-central-1) provider works for these zone writes.
resource "aws_route53_record" "cognito_custom_cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.cognito_custom.domain_validation_options :
    dvo.domain_name => {
      name   = dvo.resource_record_name
      type   = dvo.resource_record_type
      record = dvo.resource_record_value
    }
  }

  zone_id         = var.hosted_zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "cognito_custom" {
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.cognito_custom.arn
  validation_record_fqdns = [for r in aws_route53_record.cognito_custom_cert_validation : r.fqdn]
}

# Route 53 A-alias for the custom Cognito domain → its CloudFront
# distribution. The Cognito module exposes the CloudFront distribution
# domain as an output (`custom_domain_cloudfront_distribution`).
resource "aws_route53_record" "cognito_custom" {
  zone_id = var.hosted_zone_id
  name    = "auth.${var.domain}"
  type    = "A"

  alias {
    name                   = module.cognito.custom_domain_cloudfront_distribution
    zone_id                = "Z2FDTNDATAQYW2" # Cognito's CloudFront — fixed AWS value
    evaluate_target_health = false
  }
}

module "secrets" {
  source = "../../modules/secrets"

  environment             = "prod"
  name_prefix             = "dante"
  recovery_window_in_days = 7
  create_kms_key          = false

  # Wire the Cognito user-pool client secret straight into Secrets
  # Manager. Terraform owns both shape and value for this one — the
  # operator never touches it. ECS reads via the task def's `secrets:`
  # block (see below), so the value never lands in the task def JSON.
  cognito_client_secret = module.cognito.client_secret
}

# --- Security group for the sync Lambda's ENIs --------------------------
#
# Owned at the env level (not inside the sync-lambda module) because the
# RDS ingress rule needs to reference it as a source. Keeping it here
# breaks the otherwise-circular dependency between the two modules.

resource "aws_security_group" "sync_lambda" {
  name        = "dante-prod-sync-lambda"
  description = "Egress for the sync Lambda. Outbound 443 for AWS APIs + upstream HTTP, outbound 5432 for RDS."
  vpc_id      = module.vpc.vpc_id

  egress {
    description = "HTTPS to AWS APIs, Personio, awork"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "Postgres to RDS (within VPC)"
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = [module.vpc.cidr_block]
  }

  tags = {
    Name = "dante-prod-sync-lambda"
  }
}

module "rds" {
  source = "../../modules/rds"

  environment     = "prod"
  name_prefix     = "dante"
  vpc_id          = module.vpc.vpc_id
  data_subnet_ids = module.vpc.data_subnet_ids

  engine_version = var.rds_engine_version
  instance_class = var.rds_instance_class
  multi_az       = var.rds_multi_az

  # Grant ingress to the sync Lambda's SG today; the ECS app SG joins
  # this list once the app module exists.
  allowed_ingress_security_group_ids = [aws_security_group.sync_lambda.id]

  # Prod safety rails — leave on. Override only to migrate / decommission.
  deletion_protection = true
  skip_final_snapshot = false

  # The Free Plan blocks `backup_retention_period > 0` on RDS. 0
  # disables automated backups + point-in-time recovery — UNSAFE FOR
  # PRODUCTION DATA, so don't load real employee data while
  # `var.aws_free_plan` is true.
  backup_retention_days = var.aws_free_plan ? 0 : var.rds_backup_retention_days
}

module "sync_lambda" {
  source = "../../modules/sync-lambda"

  environment         = "prod"
  name_prefix         = "dante"
  package_zip_path    = var.sync_lambda_package_zip_path
  package_source_hash = filemd5(var.sync_lambda_package_zip_path)

  # App secrets — Personio creds, awork client, awork rotating tokens.
  secret_arns = module.secrets.all_secret_arns
  # Only the awork tokens secret is writable from the sync — the OAuth
  # refresh flow PutSecretValues the rotated refresh_token back each run.
  # Reads of Personio creds + awork client are scoped via secret_arns.
  writable_secret_arns = [module.secrets.awork_tokens_secret_arn]
  kms_key_arn          = null

  # RDS-managed master credential — still wired in as a break-glass
  # fallback. The Lambda's runtime prefers IAM auth (rds_iam_db_user_arns
  # below) and only falls back to the secret-arn path if IAM isn't
  # configured. Safe to drop once we've verified IAM works end-to-end.
  database_secret_arn         = module.rds.master_user_secret_arn
  database_secret_kms_key_arn = module.rds.master_user_secret_kms_key_id
  database_endpoint           = module.rds.endpoint
  database_name               = module.rds.database_name

  # RDS IAM auth — the Lambda authenticates as `dante_app` via a
  # 15-min signed token instead of the master password. Fixes the
  # rotation-vs-running-tasks race that produced the 28P01 outage.
  rds_iam_db_user_arns = [module.rds.iam_app_user_arn]
  app_db_username      = module.rds.app_username

  # VPC: app subnets, with the sync_lambda SG defined above.
  vpc_config = {
    subnet_ids         = module.vpc.app_subnet_ids
    security_group_ids = [aws_security_group.sync_lambda.id]
  }

  schedule_expression   = var.sync_lambda_schedule_expression
  alarm_email_addresses = var.sync_lambda_alarm_emails

  # The one-time Personio v2 attendance backfill pulls a full year in
  # ~100+ cursor pages (~16k WORK rows) plus a rate-limit backoff; that
  # plus the rest of the sync can exceed the 300s default. Scheduled
  # delta runs stay well under a minute. 900s is the Lambda cap and only
  # bills for time actually used.
  timeout = 900

  # -1 disables the reservation entirely on Free Plan accounts, which
  # cap account-wide concurrency below the minimum AWS requires to
  # leave unreserved (10). Paid tier: 2 = one in-flight + one overlap.
  reserved_concurrent_executions = var.aws_free_plan ? -1 : 2
}

# --- ECR / ALB / DNS / ECS for the Next.js app ---------------------------
#
# Order on first-touch:
#   1. apply with a known-good `app_image_uri` placeholder (e.g. a public
#      hello-world image) OR set `desired_count = 0` to bring up ECR +
#      ALB + cert + DNS without running tasks yet.
#   2. Build + push the container to the ECR repo URL output:
#        aws ecr get-login-password --region eu-central-1 | docker login --username AWS --password-stdin <repo>
#        docker buildx build --platform linux/arm64 -t <url>:<sha> .
#        docker push <url>:<sha>
#   3. Re-apply with `app_image_uri = "<url>:<sha>"`, which rolls the
#      task definition. Service circuit-breaker auto-rolls back on
#      failed deploys.

module "ecr" {
  source = "../../modules/ecr"

  environment = "prod"
  name_prefix = "dante"
  # Pinned explicitly: a future variable override that flipped this to
  # MUTABLE would let CI overwrite the SHA-tagged image of a known-good
  # production release. Immutable tags make rollback as simple as
  # pointing the task def at the previous SHA.
  image_tag_mutability = "IMMUTABLE"
}

data "aws_caller_identity" "current" {}

# CVE scanning on ECR pushes.
#
# Inspector v2 enhanced scanning is required here: basic `scan_on_push`
# is silently a no-op for arm64 images, and Fargate Graviton is arm64.
# Inspector v2 needs an account-level subscription that the AWS Free
# Plan blocks ("SubscriptionRequiredException" on `inspector2:Enable`),
# so both resources are gated on `var.aws_free_plan`. The deploy
# workflow's scan gate follows the same variable, so the gate is never
# armed without a scanner behind it.
#
# First deploy after flipping `aws_free_plan` to false: the build job's
# scan gate runs BEFORE this apply enables Inspector, so run that one
# via workflow_dispatch with `skip_scan_gate = true` (or let it fail
# once and re-run).
resource "aws_inspector2_enabler" "ecr" {
  count = var.aws_free_plan ? 0 : 1

  account_ids    = [data.aws_caller_identity.current.account_id]
  resource_types = ["ECR"]
}

resource "aws_ecr_registry_scanning_configuration" "this" {
  count = var.aws_free_plan ? 0 : 1

  scan_type = "ENHANCED"
  rule {
    scan_frequency = "SCAN_ON_PUSH"
    repository_filter {
      filter      = "*"
      filter_type = "WILDCARD"
    }
  }
  depends_on = [aws_inspector2_enabler.ecr]
}

module "alb" {
  source = "../../modules/alb"

  environment       = "prod"
  name_prefix       = "dante"
  vpc_id            = module.vpc.vpc_id
  public_subnet_ids = module.vpc.public_subnet_ids
  certificate_arn   = module.dns.certificate_arn

  deletion_protection = true

  # Bumped from the 60s default so the in-process /settings Sync action
  # can complete without the ALB cutting the connection mid-flight. A
  # full Personio + awork sync takes a few minutes when there are many
  # records. Long-term fix: move the sync to async Lambda invocation
  # so the HTTP request returns immediately and the browser polls for
  # progress.
  idle_timeout_seconds = 900
}

module "dns" {
  source = "../../modules/dns"

  environment    = "prod"
  name_prefix    = "dante"
  domain_name    = var.domain
  hosted_zone_id = var.hosted_zone_id

  alb_dns_name = module.alb.dns_name
  alb_zone_id  = module.alb.zone_id
}

# Allow the ECS task SG to reach RDS on 5432. Implemented at the env
# level so RDS doesn't need to know about the ECS module directly
# (avoids the circular dependency).
resource "aws_vpc_security_group_ingress_rule" "rds_from_app" {
  security_group_id            = module.rds.security_group_id
  referenced_security_group_id = module.alb.target_security_group_id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "Postgres from ECS app tasks"
}

module "app" {
  source = "../../modules/ecs-app"

  environment            = "prod"
  name_prefix            = "dante"
  vpc_id                 = module.vpc.vpc_id
  app_subnet_ids         = module.vpc.app_subnet_ids
  target_group_arn       = module.alb.target_group_arn
  task_security_group_id = module.alb.target_security_group_id

  image_uri      = var.app_image_uri
  cpu            = var.app_cpu
  memory         = var.app_memory
  desired_count  = var.app_desired_count
  container_port = 3000

  environment_variables = {
    NODE_ENV                  = "production"
    DANTE_ENV                 = "prod"
    DANTE_USE_SECRETS_MANAGER = "1"
    DANTE_LOG_LEVEL           = "info"
    AWS_REGION                = var.aws_region

    # Passkeys — OFF (rolled back, lockstep with web_authn_enabled=false
    # on the cognito module). Hides the /profile passkey UI and makes the
    # app-side strong-factor gate inert (Cognito enforces MFA again via
    # mfa=ON). Flip back to "true" together with web_authn_enabled when
    # passkeys are re-attempted.
    DANTE_PASSKEYS_ENABLED = "false"

    # Name of the sync Lambda that runSyncAction invokes. Non-sensitive
    # (the IAM grant is scoped by ARN, so the function name alone is
    # useless without the role).
    DANTE_SYNC_LAMBDA_NAME = module.sync_lambda.function_name

    # Migration runner is bundled at /app/migrate.js, so its __dirname is
    # /app and the default fallback (`__dirname/../lib/db/migrations`)
    # resolves to /lib/db/migrations — which doesn't exist. The Dockerfile
    # copies migrations to /app/lib/db/migrations; pin the path here so
    # the runner finds the meta/_journal.json drizzle needs.
    DANTE_MIGRATIONS_FOLDER = "/app/lib/db/migrations"

    # DB pointers. Runtime traffic authenticates as `dante_app` via IAM
    # auth (15-min signed token from the task role). The master
    # credential (DB_USERNAME / DB_PASSWORD below) is reserved for the
    # migration runner at container boot — the rotation race that
    # produced the 28P01 outage is moot for app traffic.
    DANTE_DATABASE_ENDPOINT = module.rds.endpoint
    DANTE_DATABASE_NAME     = module.rds.database_name
    DANTE_USE_IAM_DB_AUTH   = "1"
    DANTE_APP_DB_USERNAME   = module.rds.app_username

    # Auth.js — Cognito pointers; CLIENT_SECRET + AUTH_SECRET arrive via `secrets:` below.
    AUTH_TRUST_HOST   = "true"
    COGNITO_CLIENT_ID = module.cognito.client_id
    COGNITO_ISSUER    = module.cognito.issuer_url
    # Used by admin-side calls (e.g. AdminCreateUser from /settings/users)
    # via `lib/auth/cognito-admin.ts`.
    COGNITO_USER_POOL_ID = module.cognito.user_pool_id
    # Cognito hosted UI base URL — `/login`'s "Forgot password?" link
    # composes a redirect to <hosted-ui>/forgotPassword?...
    COGNITO_HOSTED_UI_URL = module.cognito.oauth_endpoint
    NEXTAUTH_URL          = "https://${var.domain}"

    # Agent integration — bearer-token auth on `/api/agent/*`. The
    # validator (lib/auth/agent-jwt.ts) verifies incoming tokens were
    # issued for this specific app client; a token from the web client
    # is rejected even if it would happen to carry the right scope.
    COGNITO_AGENT_CLIENT_ID = module.cognito.agent_client_id
  }

  # Native ECS secret injection — values surface as env vars to the
  # container without ever materializing in the task definition JSON
  # or CloudWatch.
  secrets = [
    {
      name       = "AUTH_SECRET"
      value_from = module.secrets.auth_secret_arn
    },
    {
      name       = "COGNITO_CLIENT_SECRET"
      value_from = module.secrets.cognito_client_secret_arn
    },
    {
      # RDS managed secret is JSON `{username, password, ...}`. The
      # `:key::` suffix extracts a single field into one env var.
      name       = "DB_USERNAME"
      value_from = "${module.rds.master_user_secret_arn}:username::"
    },
    {
      name       = "DB_PASSWORD"
      value_from = "${module.rds.master_user_secret_arn}:password::"
    },
  ]

  # awork client credentials (READ): needed for the OAuth callback to
  # exchange the authorization code for tokens. Not sensitive on its
  # own — it's the OAuth client_id + secret, not the access token.
  additional_secret_arns_readable = [
    module.secrets.awork_client_secret_arn,
    # /settings/integrations/awork needs to read the stored tokens to
    # display the connection status (expires_at, expired vs authorized).
    # H-004 originally kept this write-only on the web app's task role,
    # but the status UI was always going to need read access. Net risk:
    # an RCE'd web-app process can now exfiltrate the awork OAuth tokens
    # — small marginal increase given the same process already has DB
    # access to per-employee salary / Personio data, which is more
    # sensitive than awork API tokens.
    module.secrets.awork_tokens_secret_arn,
    # NOTE: `module.secrets.personio_secret_arn` was previously here to
    # support the in-process `/settings/sync` button. That button now
    # invokes the sync Lambda (which has its own scoped grant), so the
    # web-app task role no longer needs Personio credentials at all
    # (pre-pentest T1.6).
  ]

  # awork OAuth tokens (WRITE): the callback writes the rotated tokens
  # after exchanging the authorization code; the sync Lambda reads them
  # back. Read access is also granted above for the status UI.
  #
  # KNOWN RISK (T1.6 partial): an app-level RCE can overwrite these
  # tokens. The minimal fix would be to route the OAuth callback's
  # token-write through the sync Lambda. Deferred — too invasive
  # before pentest week. Compensating controls: the OAuth callback is
  # admin-only + audited; tokens self-rotate on every sync; a poisoned
  # token only affects future awork syncs (which surface as obvious
  # 401s in CloudWatch).
  additional_secret_arns_writable = [
    module.secrets.awork_tokens_secret_arn,
  ]

  # Sync Lambda is invoked synchronously by `runSyncAction` for the
  # /settings sync button. Scoped to this exact function ARN — the
  # task role can't invoke anything else in the account.
  additional_invokable_lambda_arns = [
    "arn:aws:lambda:${var.aws_region}:${data.aws_caller_identity.current.account_id}:function:${module.sync_lambda.function_name}",
  ]

  # RDS IAM auth — task role can call `rds-db:connect` only as the
  # `dante_app` user. Scoped per-user ARN so an RCE'd app cannot pivot
  # to the master credential (which still owns DDL).
  rds_iam_db_user_arns = [module.rds.iam_app_user_arn]
}

# Grant the web-app task role the Cognito admin permissions used by the
# /settings/users invite flow. The invite action calls AdminCreateUser to
# materialize a Cognito user (which triggers the temp-password email)
# and AdminAddUserToGroup to grant the requested role. Scoped to this
# pool's ARN only.
# CloudWatch metric filter on the app log group: counts every audit
# event of kind `view_inspect_payload`. The audit helper now emits
# each row to stdout as an `audit_event` log line in addition to
# the DB write, so the metric filter sees them in near-real-time.
#
# Alarm fires when one or more inspect payload reads happen in 5 min
# AND the cumulative count exceeds the threshold. The threshold is
# generous (50 reads / 5 min ≈ scanning 10 employees per minute) to
# avoid false positives from a manager doing focused investigation,
# while still catching a scrape attempt.
#
# Per-actor detection would need a stats-by-user_id query via
# CloudWatch Logs Insights or a scheduled Lambda — out of scope here.
# This alarm is the canary; the audit log in Postgres is the
# forensic source of truth.
resource "aws_cloudwatch_log_metric_filter" "view_inspect_payload" {
  name           = "${module.app.cluster_name}-view-inspect-payload"
  log_group_name = module.app.log_group_name
  pattern        = "{ $.event = \"audit_event\" && $.action = \"view_inspect_payload\" }"

  metric_transformation {
    name          = "ViewInspectPayloadCount"
    namespace     = "Dante/Audit"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "view_inspect_payload_spike" {
  alarm_name          = "${module.app.cluster_name}-view-inspect-payload-spike"
  alarm_description   = "Spike in /api/inspect/* reads — possible Personio-payload scrape attempt. Investigate via `SELECT user_id, COUNT(*) FROM app_audit_log WHERE action = 'view_inspect_payload' AND occurred_at > NOW() - INTERVAL '15 minutes' GROUP BY user_id ORDER BY 2 DESC`."
  namespace           = "Dante/Audit"
  metric_name         = "ViewInspectPayloadCount"
  statistic           = "Sum"
  period              = 300 # 5 min
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 50
  treat_missing_data  = "notBreaching"
  alarm_actions       = [module.sync_lambda.alarm_topic_arn]
  ok_actions          = [module.sync_lambda.alarm_topic_arn]
}

# Same shape for `view_salary` — the other most-sensitive read. The
# threshold is slightly lower because the universe of legitimate
# callers is tighter (only managers + admins, and salary deep-dive
# isn't a daily activity).
resource "aws_cloudwatch_log_metric_filter" "view_salary" {
  name           = "${module.app.cluster_name}-view-salary"
  log_group_name = module.app.log_group_name
  pattern        = "{ $.event = \"audit_event\" && $.action = \"view_salary\" }"

  metric_transformation {
    name          = "ViewSalaryCount"
    namespace     = "Dante/Audit"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "view_salary_spike" {
  alarm_name          = "${module.app.cluster_name}-view-salary-spike"
  alarm_description   = "Spike in salary-history / salary-trajectory reads — possible comp-data scrape. Investigate via `SELECT user_id, COUNT(*) FROM app_audit_log WHERE action = 'view_salary' AND occurred_at > NOW() - INTERVAL '15 minutes' GROUP BY user_id ORDER BY 2 DESC`."
  namespace           = "Dante/Audit"
  metric_name         = "ViewSalaryCount"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 30
  treat_missing_data  = "notBreaching"
  alarm_actions       = [module.sync_lambda.alarm_topic_arn]
  ok_actions          = [module.sync_lambda.alarm_topic_arn]
}

resource "aws_iam_role_policy" "app_cognito_admin" {
  name = "${module.app.task_role_name}-cognito-admin"
  role = module.app.task_role_name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "cognito-idp:AdminCreateUser",
        "cognito-idp:AdminAddUserToGroup",
        "cognito-idp:AdminRemoveUserFromGroup",
        "cognito-idp:AdminGetUser",
        "cognito-idp:AdminDeleteUser",
        "cognito-idp:AdminResetUserPassword",
        "cognito-idp:AdminDisableUser",
        "cognito-idp:AdminEnableUser",
        "cognito-idp:AdminUserGlobalSignOut",
      ]
      Resource = module.cognito.user_pool_arn
    }]
  })
}

module "waf" {
  source = "../../modules/waf"

  environment = "prod"
  name_prefix = "dante"
  alb_arn     = module.alb.arn
  enabled     = var.waf_enabled

  # Default managed groups (Common + KnownBad + IpReputation + SQLi) on.
  # AnonymousIp off — legitimate users sometimes route through VPNs;
  # turn it on if abuse warrants the trade-off.
  enable_common_rules       = true
  enable_known_bad_inputs   = true
  enable_sqli_rules         = true
  enable_ip_reputation      = true
  enable_anonymous_ip_block = false

  # Rate limits: hostile auth-page brute force gets cut at 100/IP/5min;
  # general scrapers at 2000/IP/5min. Both are well above any legitimate
  # user pattern at 40-person scale.
  auth_path_rate_limit_per_5min = 100
  global_rate_limit_per_5min    = 2000

  # Geo — defaults to no filter. Set `waf_geo_allow_list = ["DE","AT","CH"]`
  # in terraform.tfvars to lock to DACH if the org needs it; remember
  # admins traveling outside the list are blocked.
  geo_allow_list = var.waf_geo_allow_list

  enable_logging        = true
  log_retention_days    = 30
  alarm_email_addresses = var.waf_alarm_emails
}

module "github_oidc" {
  source = "../../modules/github-oidc"

  environment       = "prod"
  name_prefix       = "dante"
  github_repository = var.github_repository

  # The check workflow runs on every PR + push; the deploy workflow only
  # on the protected branch (`main` by default).
  deploy_role_branch_filter = "main"

  # The terraform_apply job in deploy.yml runs in the `production`
  # GitHub Environment so the manual approval gate kicks in. GitHub
  # re-scopes the OIDC sub for environment-scoped jobs, so we need
  # to allow that subject shape in addition to `ref:refs/heads/main`.
  deploy_role_environments = ["production"]

  ecr_repository_arn = module.ecr.repository_arn
  ecs_cluster_arn    = module.app.cluster_arn
  ecs_service_arns = [
    # ECS service ARN isn't exported directly by name; compose from cluster + service name.
    "arn:aws:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:service/${module.app.cluster_name}/${module.app.service_name}",
  ]
  task_role_arns_passable = [
    module.app.task_role_arn,
    module.app.execution_role_arn,
  ]
  lambda_function_arns = [
    "arn:aws:lambda:${var.aws_region}:${data.aws_caller_identity.current.account_id}:function:${module.sync_lambda.function_name}",
    "arn:aws:lambda:${var.aws_region}:${data.aws_caller_identity.current.account_id}:function:${module.cognito_pretoken_lambda.function_name}",
  ]

  # RDS — the deploy role needs `rds:ModifyDBInstance` to apply
  # in-place changes like flipping `iam_database_authentication_enabled`.
  # Scoped to the single prod instance. Destructive actions are NOT
  # granted by the module — see the variable doc.
  rds_db_instance_arns = [module.rds.instance_arn]

  # ALB — the deploy role needs `elasticloadbalancing:SetWebACL` so
  # `aws_wafv2_web_acl_association` can attach / detach the public
  # WAF Web ACL on the ALB. Scoped to the single prod ALB.
  alb_arns_waf_managed = [module.alb.arn]

  # Bootstrap permissions for modules that materialize their own
  # IAM role + Lambda function + log group on first apply (currently
  # cognito-pretoken-lambda; future ones share the same prefix
  # namespace). Wildcards stay project-scoped: a compromised deploy
  # token can create new roles + functions inside `dante-prod-*`, not
  # arbitrary names.
  creatable_iam_role_arns = [
    "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/dante-prod-*",
  ]
  creatable_lambda_function_arns = [
    "arn:aws:lambda:${var.aws_region}:${data.aws_caller_identity.current.account_id}:function:dante-prod-*",
  ]
  creatable_log_group_arns = [
    "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/dante-prod-*",
    "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/dante-prod-*:log-stream:",
  ]

  # PassRole for Lambda creation. Each new Lambda role's ARN needs
  # to appear here — the IAM:PassRole condition pins it to
  # lambda.amazonaws.com so the grant is unusable elsewhere.
  lambda_role_arns_passable = [
    module.cognito_pretoken_lambda.role_arn,
  ]

  # CloudWatch alarm management. The sync Lambda owns several alarms
  # (errors, throttles, duration); the pretoken Lambda module
  # creates `errors`. Wildcard scoped to the project namespace.
  cloudwatch_alarm_arns = [
    "arn:aws:cloudwatch:${var.aws_region}:${data.aws_caller_identity.current.account_id}:alarm:dante-prod-*",
  ]

  # Cognito user pool sub-resource management — terraform creates the
  # dante-agents resource server, the agent app client, and updates
  # `lambda_config` on the parent pool to wire the Pre Token Gen
  # Lambda. All of those need pool-level Cognito perms.
  cognito_user_pool_arns = [
    module.cognito.user_pool_arn,
  ]

  # Inline-policy writes on roles whose `aws_iam_role_policy` resources
  # terraform reconciles on every apply. The sync's `secrets` policy
  # tracks added/removed secret ARNs; the app task role's `task_rds_iam`
  # policy tracks the rds-db:connect user ARN list; the app exec role
  # also gets `*-exec-secrets` rewritten when the secrets/value-from set
  # changes. Each is included explicitly so the grant is auditable
  # against the module that owns it. The deploy role's own ARN is
  # intentionally absent — a compromised deploy token must not be able
  # to self-escalate.
  managed_iam_role_arns = [
    module.sync_lambda.role_arn,
    module.app.task_role_arn,
    module.app.execution_role_arn,
  ]

  # EventBridge rule maintenance — the sync Lambda's schedule. PutRule
  # is needed whenever we change the cron expression (e.g. moving
  # from 06:00 UTC to 04:00 UTC); TagResource is required because
  # terraform tags the rule with the standard App/Environment/
  # DataClass set.
  eventbridge_rule_arns = compact([
    module.sync_lambda.schedule_rule_arn,
  ])

  # SNS topics terraform manages — sync Lambda alarm topic + WAF
  # alarm topic. Needed for Subscribe (email subscriptions) and tag
  # reconciliation. Add new alarm topics here as modules are added.
  sns_topic_arns = compact([
    module.sync_lambda.alarm_topic_arn,
    module.waf.alarm_topic_arn,
  ])

  # Remote state lives in S3 (bucket + DynamoDB lock table created by
  # terraform/envs/bootstrap-state). GH Actions needs read+write on
  # both to run `terraform plan/apply` against the same state file the
  # operator uses locally.
  terraform_state_bucket_arn     = "arn:aws:s3:::dante-tfstate"
  terraform_state_lock_table_arn = "arn:aws:dynamodb:${var.aws_region}:${data.aws_caller_identity.current.account_id}:table/dante-tfstate-lock"

  # Cognito client secret is the only secret VALUE terraform manages —
  # CI needs Get + Put on its specific ARN. Every other prod credential
  # (Personio, awork client/tokens, AUTH_SECRET) has its container
  # created by terraform but the value is written out-of-band; CI only
  # needs DescribeSecret on those, NOT GetSecretValue. Was previously
  # bundled into a wildcard `dante/prod/*` grant which let CI read
  # every secret in prod (T2.2 split).
  secret_arns_read_write = [
    module.secrets.cognito_client_secret_arn,
  ]
  secret_arns_describe_only = [
    module.secrets.personio_secret_arn,
    module.secrets.awork_client_secret_arn,
    module.secrets.awork_tokens_secret_arn,
    module.secrets.auth_secret_arn,
  ]
}
