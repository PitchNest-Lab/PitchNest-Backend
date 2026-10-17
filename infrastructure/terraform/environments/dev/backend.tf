terraform {
  backend "s3" {
    bucket       = "pitchnest-terraform-state-639324724698"
    key          = "dev/terraform.tfstate"
    region       = "eu-west-2"
    encrypt      = true
    use_lockfile = true
  }
}