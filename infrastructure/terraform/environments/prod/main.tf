# PitchNest PROD REST API: Lambda (alias "live") behind an HTTP API.
#
# Nothing here routes production traffic: the frontend keeps its current REST
# target until a separate, approved cutover. Until the pipeline deploys a
# reviewed release, the function serves a placeholder that answers 503.

data "aws_caller_identity" "current" {}

# Visible (non-blocking) confirmation in every plan; the provider's
# allowed_account_ids is the hard stop.
check "prod_account_guard" {
  assert {
    condition     = data.aws_caller_identity.current.account_id == local.prod_account_id
    error_message = "Credentials are not for the PROD account ${local.prod_account_id}."
  }
}

locals {
  environment_variables = merge(
    {
      NODE_ENV       = "production" # enforces the CORS allow-list in src/app.ts
      PITCHNEST_ENV  = "prod"       # selects /pitchnest/prod/ in loadAwsParameters
      CLIENT_URL     = var.frontend_url
      ALLOWED_ORIGIN = var.frontend_url
      APP_BASE_URL   = var.frontend_url

      AZURE_OPENAI_API_VERSION = var.azure_openai_api_version

      # Future subscription price: Pro, USD 10 for 30 days. Checkout only ever
      # sells this SKU (src/config/env.ts PURCHASABLE_SKU) and stays OFF until
      # billing_checkout_enabled = true AND the Flutterwave keys are loadable.
      PRO_PLAN_AMOUNT          = "10"
      PRO_PLAN_CURRENCY        = "USD"
      PRO_PLAN_DAYS            = "30"
      BILLING_CHECKOUT_ENABLED = var.billing_checkout_enabled ? "true" : "false"
    },
    var.extra_environment_variables,
  )
}

# Reviewed placeholder handler (bootstrap/index.mjs). Packaged locally into the
# git-ignored .terraform/ directory; no build output from dist/ is referenced.
data "archive_file" "bootstrap" {
  type        = "zip"
  source_file = "${path.module}/bootstrap/index.mjs"
  output_path = "${path.module}/.terraform/bootstrap/pitchnest-prod-placeholder.zip"
}

module "api_lambda" {
  source = "../../modules/lambda_service"

  function_name = var.function_name
  description   = "PitchNest PROD REST API (code deployed by pipeline; traffic via alias live)"

  runtime              = "nodejs22.x"
  handler              = "index.handler"
  architecture         = "x86_64"
  memory_size          = var.memory_size
  timeout              = var.timeout
  reserved_concurrency = var.reserved_concurrency

  bootstrap_package_path = data.archive_file.bootstrap.output_path
  bootstrap_package_hash = data.archive_file.bootstrap.output_base64sha256

  environment_variables = local.environment_variables

  ssm_parameter_path  = "/pitchnest/prod/"
  ssm_parameter_names = var.ssm_parameter_names
  ssm_kms_key_arn     = var.ssm_kms_key_arn

  log_retention_days = var.log_retention_days
  alias_name         = "live"
}

module "api_gateway" {
  source = "../../modules/http_api"

  api_name    = "pitchnest-prod-api"
  description = "PitchNest PROD REST API"

  lambda_function_name    = module.api_lambda.function_name
  lambda_alias_name       = module.api_lambda.alias_name
  lambda_alias_invoke_arn = module.api_lambda.alias_invoke_arn

  integration_timeout_ms = 30000

  # Default endpoint stays OFF until release (explicit variable, default false).
  disable_execute_api_endpoint = !var.api_public_endpoint_enabled

  throttling_rate_limit     = var.throttling_rate_limit
  throttling_burst_limit    = var.throttling_burst_limit
  access_log_retention_days = var.log_retention_days
}

module "observability" {
  source = "../../modules/observability"

  name_prefix            = "pitchnest-prod-api"
  lambda_function_name   = module.api_lambda.function_name
  lambda_alias_name      = module.api_lambda.alias_name
  lambda_timeout_seconds = var.timeout
  api_id                 = module.api_gateway.api_id
  api_stage              = module.api_gateway.stage_name
  alarm_email_endpoints  = var.alarm_email_endpoints

  # Alarms evaluate from day one; notifications start at release.
  alarm_actions_enabled = var.alarm_notifications_enabled
  api_5xx_threshold     = var.api_5xx_threshold

  # No SSE on the operational alarm topic (alias/aws/sns is incompatible with
  # CloudWatch). Set a customer-managed key ARN here if a control requires SSE.
  sns_kms_key_arn = null
}
