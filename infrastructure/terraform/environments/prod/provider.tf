locals {
  # Account guard. Deliberately a local (not a variable) so it cannot be
  # overridden with -var on the command line.
  prod_account_id = "415081251151"
  aws_region      = "eu-west-2"
}

provider "aws" {
  region = local.aws_region

  # Hard stop: every plan/apply fails unless the credentials belong to the
  # PROD account. Protects DEV (639324724698) from accidental PROD configs.
  allowed_account_ids = [local.prod_account_id]

  default_tags {
    tags = {
      Project     = var.project_name
      Environment = "prod"
      ManagedBy   = "Terraform"
      Repository  = "PitchNest-Lab/PitchNest-Backend"
    }
  }
}
