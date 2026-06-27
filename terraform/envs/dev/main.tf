provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      App         = "dante"
      Environment = "dev"
      ManagedBy   = "terraform"
      Repo        = "Dante"
    }
  }
}

module "cognito" {
  source = "../../modules/cognito"

  environment       = "dev"
  name_prefix       = "dante"
  callback_urls     = var.callback_urls
  logout_urls       = var.logout_urls
  seed_admin_emails = var.seed_admin_emails
  # WebAuthn relying-party ID for the dev pool. `localhost` is the
  # one non-public RPID browsers accept for testing — passkeys
  # registered against it only work for the local dev server, which
  # is exactly the scope we want for dev.
  domain_name = "localhost"
}
