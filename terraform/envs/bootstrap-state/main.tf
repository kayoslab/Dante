/**
 * Bootstrap stack for the remote terraform state backend.
 *
 * Exists once per AWS account, not per environment. Creates the S3
 * bucket that holds every other stack's tfstate plus the DynamoDB
 * table used for cross-operator state locking. Both are immutable
 * once created — operators add new env keys under `prod/`, `dev/`,
 * etc., never new buckets.
 *
 * State for THIS stack stays local (chicken-and-egg: a remote backend
 * for the bootstrap stack would itself need a remote backend). The
 * resulting `terraform.tfstate` here is committed to the operator's
 * laptop only — the resources are trivially recreatable from this
 * directory, and the bucket / table names are well-known.
 */

terraform {
  required_version = ">= 1.7.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.83"
    }
  }

  backend "local" {
    path = "terraform.tfstate"
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = "Dante"
      ManagedBy = "Terraform"
      Stack     = "bootstrap-state"
    }
  }
}

variable "region" {
  description = "AWS region. Must match the region every other stack deploys to — putting the state bucket in a different region adds inter-region latency on every plan and complicates IAM."
  type        = string
  default     = "eu-central-1"
}

variable "bucket_name" {
  description = "S3 bucket name for terraform state. Globally unique."
  type        = string
  default     = "dante-tfstate"
}

variable "lock_table_name" {
  description = "DynamoDB table name for state locking. One row per `<env>/terraform.tfstate` key."
  type        = string
  default     = "dante-tfstate-lock"
}

# ---------------------------------------------------------------------------
# S3 bucket for state
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "state" {
  bucket = var.bucket_name

  # Versioning + encrypted at rest is non-negotiable — the state file
  # contains every secret ARN, Cognito user pool ID, RDS endpoint, etc.
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket = aws_s3_bucket.state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Lifecycle: keep current versions forever, expire prior versions after
# 90 days. State file changes ~every deploy and old versions accumulate
# fast otherwise.
resource "aws_s3_bucket_lifecycle_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    id     = "expire-old-versions"
    status = "Enabled"

    filter {} # apply to all objects

    noncurrent_version_expiration {
      noncurrent_days = 90
    }
  }
}

# ---------------------------------------------------------------------------
# DynamoDB lock table
# ---------------------------------------------------------------------------

resource "aws_dynamodb_table" "lock" {
  name         = var.lock_table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }

  # Single-table; one row per state key, evicted automatically when
  # terraform releases the lock. PAY_PER_REQUEST avoids the 1-RCU
  # provisioned minimum (~$0.30/month) for what is effectively idle.
  lifecycle {
    prevent_destroy = true
  }
}

# ---------------------------------------------------------------------------
# Outputs
# ---------------------------------------------------------------------------

output "bucket_name" {
  description = "S3 bucket holding remote state. Plug into other stacks' `backend \"s3\"` block as `bucket = ...`."
  value       = aws_s3_bucket.state.id
}

output "bucket_arn" {
  description = "ARN — needed for the IAM policies on operator + CI roles that read/write state."
  value       = aws_s3_bucket.state.arn
}

output "lock_table_name" {
  description = "DynamoDB lock table. Plug into other stacks' backend block as `dynamodb_table = ...`."
  value       = aws_dynamodb_table.lock.name
}

output "lock_table_arn" {
  description = "ARN — needed for the IAM policies on operator + CI roles that take state locks."
  value       = aws_dynamodb_table.lock.arn
}
