terraform {
  # Local state for dev — single workstation, no team coordination needed yet.
  # When/if multiple operators provision dev resources, switch to:
  #   backend "s3" {
  #     bucket         = "dante-tfstate"
  #     key            = "dev/terraform.tfstate"
  #     region         = "eu-central-1"
  #     dynamodb_table = "dante-tfstate-lock"
  #     encrypt        = true
  #   }
  backend "local" {
    path = "terraform.tfstate"
  }
}
