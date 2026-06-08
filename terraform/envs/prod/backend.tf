terraform {
  # Local state for prod — single-operator deploys today. State file is
  # GDPR-sensitive (contains Cognito IDs, secret ARNs). Treat
  # `terraform.tfstate` and `terraform.tfstate.backup` as confidential:
  # never commit, never share, keep encrypted at rest on the operator's
  # workstation.
  #
  # Migrate to S3 + DynamoDB locking when a second operator joins:
  #   1. Create the bucket + table out-of-band (or via a one-off bootstrap stack).
  #   2. Replace this block with:
  #        backend "s3" {
  #          bucket         = "dante-tfstate"
  #          key            = "prod/terraform.tfstate"
  #          region         = "eu-central-1"
  #          dynamodb_table = "dante-tfstate-lock"
  #          encrypt        = true
  #        }
  #   3. Run `terraform init -migrate-state` from this directory.
  backend "local" {
    path = "terraform.tfstate"
  }
}
