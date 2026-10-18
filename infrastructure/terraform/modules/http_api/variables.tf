variable "api_name" {
  description = "HTTP API name"
  type        = string
}

variable "description" {
  description = "HTTP API description"
  type        = string
  default     = ""
}

variable "lambda_function_name" {
  description = "Target Lambda function name"
  type        = string
}

variable "lambda_alias_name" {
  description = "Target Lambda alias (traffic is never routed to $LATEST)"
  type        = string
}

variable "lambda_alias_invoke_arn" {
  description = "Invoke ARN of the target alias"
  type        = string
}

variable "integration_timeout_ms" {
  description = "Integration timeout (max 30000 for HTTP APIs)"
  type        = number
  default     = 30000

  validation {
    condition     = var.integration_timeout_ms >= 50 && var.integration_timeout_ms <= 30000
    error_message = "integration_timeout_ms must be 50-30000."
  }
}

variable "throttling_rate_limit" {
  description = "Steady-state requests per second for the stage"
  type        = number
  default     = 50
}

variable "throttling_burst_limit" {
  description = "Burst capacity for the stage"
  type        = number
  default     = 100
}

variable "detailed_metrics_enabled" {
  description = "Per-route CloudWatch metrics"
  type        = bool
  default     = true
}

variable "disable_execute_api_endpoint" {
  description = "Disable the default execute-api URL (e.g. before the first release, or once a custom domain is in place)"
  type        = bool
  default     = false
}

variable "access_log_retention_days" {
  description = "Access log retention"
  type        = number
  default     = 90
}

variable "log_kms_key_arn" {
  description = "Optional customer-managed KMS key for the access log group"
  type        = string
  default     = null
}
