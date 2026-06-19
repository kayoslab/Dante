terraform {
  required_version = ">= 1.7.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.83"
    }
  }

  # No backend block — local state is fine for the LocalStack env. Prod
  # uses S3 + DynamoDB locking (see envs/dev/backend.tf as the template).
}
