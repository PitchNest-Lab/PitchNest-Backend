# PROD state lives in a SEPARATE bucket inside the PROD account (415081251151).
# The bucket is a prerequisite and is NOT created by this configuration; see
# README.md ("State bucket requirements") for the required settings.
#
# Credentials come from the environment (AWS_PROFILE=pitchnest-prod locally, or
# GitHub Actions OIDC in CI). No profile is hardcoded so CI can reuse this file.
terraform {
  backend "s3" {
    bucket       = "pitchnest-terraform-state-415081251151"
    key          = "prod/pitchnest-api/terraform.tfstate"
    region       = "eu-west-2"
    encrypt      = true
    use_lockfile = true

    # Refuse to read or write PROD state with credentials from any other
    # account (e.g. the DEV profile).
    allowed_account_ids = ["415081251151"]
  }
}
