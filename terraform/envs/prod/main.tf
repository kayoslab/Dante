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

module "vpc" {
  source = "../../modules/vpc"

  environment        = "prod"
  name_prefix        = "dante"
  cidr_block         = var.vpc_cidr_block
  az_count           = var.vpc_az_count
  single_nat_gateway = var.vpc_single_nat_gateway
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
}

module "secrets" {
  source = "../../modules/secrets"

  environment             = "prod"
  name_prefix             = "dante"
  recovery_window_in_days = 7
  create_kms_key          = false
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
}

module "sync_lambda" {
  source = "../../modules/sync-lambda"

  environment         = "prod"
  name_prefix         = "dante"
  package_zip_path    = var.sync_lambda_package_zip_path
  package_source_hash = filemd5(var.sync_lambda_package_zip_path)

  # App secrets — Personio creds, awork client, awork rotating tokens.
  secret_arns = module.secrets.all_secret_arns
  kms_key_arn = null

  # RDS-managed master credential — read at boot and composed into
  # DATABASE_URL by `lib/sync/db.ts::resolveDatabaseUrl`.
  database_secret_arn         = module.rds.master_user_secret_arn
  database_secret_kms_key_arn = module.rds.master_user_secret_kms_key_id
  database_endpoint           = module.rds.endpoint
  database_name               = module.rds.database_name

  # VPC: app subnets, with the sync_lambda SG defined above.
  vpc_config = {
    subnet_ids         = module.vpc.app_subnet_ids
    security_group_ids = [aws_security_group.sync_lambda.id]
  }

  schedule_expression   = var.sync_lambda_schedule_expression
  alarm_email_addresses = var.sync_lambda_alarm_emails

  reserved_concurrent_executions = 2
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
}

module "alb" {
  source = "../../modules/alb"

  environment       = "prod"
  name_prefix       = "dante"
  vpc_id            = module.vpc.vpc_id
  public_subnet_ids = module.vpc.public_subnet_ids
  certificate_arn   = module.dns.certificate_arn

  deletion_protection = true
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

    # DB pointers — username + password injected via `secrets:` below.
    DANTE_DATABASE_ENDPOINT = module.rds.endpoint
    DANTE_DATABASE_NAME     = module.rds.database_name

    # Auth.js — Cognito pointers; client secret + AUTH_SECRET arrive via `secrets:`.
    AUTH_TRUST_HOST   = "true"
    COGNITO_CLIENT_ID = module.cognito.client_id
    COGNITO_ISSUER    = module.cognito.issuer_url
    NEXTAUTH_URL      = "https://${var.domain}"
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
  ]

  # awork OAuth tokens (WRITE only): the callback writes them after
  # exchanging the code; the sync Lambda is the only thing that reads
  # them. RCE in the web app can overwrite but not exfiltrate (was H-004).
  additional_secret_arns_writable = [
    module.secrets.awork_tokens_secret_arn,
  ]
}

module "waf" {
  source = "../../modules/waf"

  environment = "prod"
  name_prefix = "dante"
  alb_arn     = module.alb.arn

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
  ]
}

data "aws_caller_identity" "current" {}
