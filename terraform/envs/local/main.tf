/**
 * Local environment — targets LocalStack so we can `terraform apply` the
 * full stack without an AWS account. This is the proving ground for
 * module changes before they touch dev/prod.
 *
 * Cognito is omitted: LocalStack's cognito-idp emulation is incomplete
 * (groups + app clients drift from AWS behavior). Auth in dev uses the
 * Credentials provider; the Cognito module is exercised in envs/dev.
 *
 * Region pinning matches the real prod region so any region-coupled
 * config (KMS aliases, ARN parsing) surfaces here first.
 */

provider "aws" {
  region                      = "eu-central-1"
  access_key                  = "test"
  secret_key                  = "test"
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true

  # All AWS services LocalStack emulates point at localhost:4566. Override
  # via env var (TF_VAR_localstack_endpoint) if you map a different port.
  endpoints {
    kms            = var.localstack_endpoint
    secretsmanager = var.localstack_endpoint
    sts            = var.localstack_endpoint
    iam            = var.localstack_endpoint
  }

  default_tags {
    tags = {
      App         = "dante"
      Environment = "local"
      ManagedBy   = "terraform"
    }
  }
}

module "secrets" {
  source = "../../modules/secrets"

  environment             = "local"
  name_prefix             = "dante"
  # LocalStack 3.x doesn't simulate the soft-delete recovery window —
  # passing >0 means destroys fail. Zero it out for clean teardowns.
  recovery_window_in_days = 0
  # Customer-managed key works in LocalStack but adds noise; alias-only
  # is enough to prove the module wiring end-to-end.
  create_kms_key = true
}
