variable "name_prefix" {
  description = "Prefix for alarm and topic names"
  type        = string
}

variable "lambda_function_name" {
  description = "Lambda function name"
  type        = string
}

variable "lambda_alias_name" {
  description = "Alias whose metrics are alarmed"
  type        = string
}

variable "lambda_timeout_seconds" {
  description = "Function timeout, used to derive the duration threshold (80%)"
  type        = number
}

variable "api_id" {
  description = "HTTP API id"
  type        = string
}

variable "api_stage" {
  description = "HTTP API stage name"
  type        = string
}

variable "alarm_email_endpoints" {
  description = "Email addresses subscribed to alarms (each must confirm). Empty = topic only."
  type        = list(string)
  default     = []
}

variable "sns_kms_key_arn" {
  description = "Customer-managed KMS key for the alarm topic. null = no SSE. Never use alias/aws/sns: CloudWatch cannot use the AWS-managed SNS key, so notifications would silently fail."
  type        = string
  default     = null

  validation {
    condition     = var.sns_kms_key_arn == null || !can(regex("alias/aws/sns", var.sns_kms_key_arn))
    error_message = "alias/aws/sns cannot be used for CloudWatch alarm topics; supply a customer-managed key ARN or null."
  }
}

variable "alarm_actions_enabled" {
  description = "Send alarm/OK notifications. When false, alarms still evaluate and change state; only notifications are suppressed."
  type        = bool
  default     = true
}

variable "lambda_error_threshold" {
  description = "Lambda errors per 5 minutes that trigger the alarm"
  type        = number
  default     = 1
}

variable "api_5xx_threshold" {
  description = "API 5xx responses per 5 minutes that trigger the alarm. Counts intentional 503s too (placeholder, billing_unavailable)."
  type        = number
  default     = 20

  validation {
    condition     = var.api_5xx_threshold >= 1
    error_message = "api_5xx_threshold must be at least 1."
  }
}

variable "api_latency_p95_ms" {
  description = "API p95 latency threshold in ms"
  type        = number
  default     = 10000
}
