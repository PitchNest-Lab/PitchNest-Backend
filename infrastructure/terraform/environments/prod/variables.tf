variable "project_name" {
  description = "Project tag"
  type        = string
  default     = "PitchNest"
}

variable "function_name" {
  description = "PROD Lambda function name"
  type        = string
  default     = "pitchnest-prod-api"
}

variable "frontend_url" {
  description = "Public frontend origin used for CORS, email links and payment return URLs"
  type        = string
  default     = "https://www.pitchnest.app"

  validation {
    condition     = can(regex("^https://[^/]+$", var.frontend_url))
    error_message = "frontend_url must be an https origin without a trailing slash or path."
  }
}

variable "extra_environment_variables" {
  description = "Additional NON-SECRET environment variables (e.g. CORS_EXTRA_ORIGINS, EMAIL_FROM). Cannot override the managed keys set in main.tf."
  type        = map(string)
  default     = {}

  validation {
    condition = length(setintersection(keys(var.extra_environment_variables), [
      "NODE_ENV", "PITCHNEST_ENV", "CLIENT_URL", "ALLOWED_ORIGIN", "APP_BASE_URL",
      "AZURE_OPENAI_API_VERSION", "PRO_PLAN_AMOUNT", "PRO_PLAN_CURRENCY", "PRO_PLAN_DAYS",
      "BILLING_CHECKOUT_ENABLED",
    ])) == 0
    error_message = "extra_environment_variables must not override managed keys (NODE_ENV, PITCHNEST_ENV, URLs, Azure API version, pricing, BILLING_CHECKOUT_ENABLED)."
  }
}

variable "azure_openai_api_version" {
  description = "Azure OpenAI API version (non-secret). Must support max_completion_tokens on classic endpoints."
  type        = string
  default     = "2026-07-09"

  validation {
    condition     = can(regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}(-preview)?$", var.azure_openai_api_version))
    error_message = "azure_openai_api_version must look like YYYY-MM-DD or YYYY-MM-DD-preview."
  }
}

variable "billing_checkout_enabled" {
  description = <<-EOT
    Billing kill switch, exported as BILLING_CHECKOUT_ENABLED. Checkout is only
    possible when this is true AND the Lambda can load FLW_SECRET_KEY and
    FLW_WEBHOOK_HASH (it currently cannot: they are not in ssm_parameter_names).
    Keep false: PitchNest is not accepting subscription payments.
  EOT
  type        = bool
  default     = false
}

variable "ssm_parameter_names" {
  description = <<-EOT
    Exact parameter names under /pitchnest/prod/ the function may read. MUST
    match PARAMETER_NAMES in src/config/loadAwsParameters.ts — extend both
    together (e.g. FLW_SECRET_KEY / FLW_WEBHOOK_HASH in Phase 1).
  EOT
  type        = list(string)
  default = [
    "JWT_SECRET",
    "SUPABASE_URL",
    "SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "RESEND_API_KEY",
    "GOOGLE_CLIENT_ID",
    "AZURE_OPENAI_ENDPOINT",
    "AZURE_OPENAI_API_KEY",
    "AZURE_OPENAI_DEPLOYMENT",
  ]
}

variable "ssm_kms_key_arn" {
  description = "Customer-managed KMS key for the PROD SecureStrings (null = alias/aws/ssm)"
  type        = string
  default     = null
}

variable "memory_size" {
  description = "Lambda memory (MB). DEV peaks at ~157 MB of 512."
  type        = number
  default     = 512
}

variable "timeout" {
  description = "Lambda timeout (s); HTTP API caps integrations at 30 s"
  type        = number
  default     = 30
}

variable "reserved_concurrency" {
  description = "Reserved concurrency (-1 = unreserved). Check 'aws lambda get-account-settings' first."
  type        = number
  default     = -1
}

variable "throttling_rate_limit" {
  description = "API stage steady-state requests/second"
  type        = number
  default     = 50
}

variable "throttling_burst_limit" {
  description = "API stage burst"
  type        = number
  default     = 100
}

variable "log_retention_days" {
  description = "Retention for Lambda and API access logs (access logs contain client IPs)"
  type        = number
  default     = 90
}

variable "api_public_endpoint_enabled" {
  description = <<-EOT
    Enable the public execute-api endpoint. Keep FALSE until the first reviewed
    release has passed qualified-version smoke tests (aws lambda invoke
    --qualifier <VERSION>) and the live alias has been moved. While false, the
    default endpoint is disabled entirely, so not even the 503 placeholder is
    publicly reachable.
  EOT
  type        = bool
  default     = false
}

variable "alarm_notifications_enabled" {
  description = <<-EOT
    Send alarm/OK notifications to the SNS topic. Keep FALSE until release:
    alarms still evaluate and record state history, but nobody is paged by
    pre-release noise.
  EOT
  type        = bool
  default     = false
}

variable "api_5xx_threshold" {
  description = <<-EOT
    HTTP API 5xx responses per 5 minutes that trigger the 5xx alarm. This
    metric counts INTENTIONAL 503s: the pre-release placeholder answers 503 to
    every request, and the application returns 503 for billing_unavailable
    (checkout while Flutterwave is unconfigured) and for Google sign-in when
    GOOGLE_CLIENT_ID is missing. Lambda Errors is the primary failure signal.
  EOT
  type        = number
  default     = 20
}

variable "alarm_email_endpoints" {
  description = "Alarm notification emails (each must confirm the SNS subscription)"
  type        = list(string)
  default     = []
}
