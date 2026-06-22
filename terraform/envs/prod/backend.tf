terraform {
  # Remote state in S3 + DynamoDB locking. The bucket + table are
  # owned by `terraform/envs/bootstrap-state/` (separate one-time
  # apply, local state). Both have `prevent_destroy = true` so an
  # accidental `terraform destroy` from this stack can't wipe them.
  #
  # State contains Cognito IDs, secret ARNs, and other GDPR-sensitive
  # metadata. The bucket has versioning + AES256-at-rest + block public
  # access. IAM access is scoped to operator IAM users + the GH
  # deploy/check roles.
  backend "s3" {
    bucket         = "dante-tfstate"
    key            = "prod/terraform.tfstate"
    region         = "eu-central-1"
    dynamodb_table = "dante-tfstate-lock"
    encrypt        = true
  }
}
