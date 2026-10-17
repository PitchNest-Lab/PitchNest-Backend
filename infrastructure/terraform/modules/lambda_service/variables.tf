variable "function_name" {
  description = "Lambda function name"
  type        = string
}

variable "description" {
  description = "Lambda function description"
  type        = string
  default     = ""
}

variable "role_name" {
  description = "Execution role name. Defaults to <function_name>-execution"
  type        = string
  default     = null
}

variable "permissions_boundary_arn" {
  description = "Optional IAM permissions boundary for the execution role"
  type        = string
  default     = null
}

variable "runtime" {
  description = "Lambda runtime"
  type        = string
  default     = "nodejs22.x"
}

variable "handler" {
  description = "Lambda handler"
  type        = string
  default     = "index.handler"
}

variable "architecture" {
  description = "Instruction set architecture"
  type        = string
  default     = "x86_64"

  validation {
    condition     = contains(["x86_64", "arm64"], var.architecture)
    error_message = "architecture must be x86_64 or arm64."
  }
}

variable "memory_size" {
  description = "Memory in MB"
  type        = number
  default     = 512
}

variable "timeout" {
  description = "Timeout in seconds. API Gateway HTTP APIs cap integrations at 30 s."
  type        = number
  default     = 30

  validation {
    condition     = var.timeout >= 1 && var.timeout <= 30
    error_message = "timeout must be 1-30 seconds (HTTP API integration limit)."
  }
}

variable "reserved_concurrency" {
  description = "Reserved concurrency. -1 = unreserved. Check the account quota first (new accounts may have only 10)."
  type        = number
  default     = -1
}

variable "bootstrap_package_path" {
  description = "Path to the initial (placeholder) deployment package used only at creation"
  type        = string
}

variable "bootstrap_package_hash" {
  description = "base64 SHA-256 of the bootstrap package"
  type        = string
}

variable "environment_variables" {
  description = "NON-SECRET environment variables owned by Terraform. Secrets belong in SSM."
  type        = map(string)
  default     = {}

  validation {
    condition = alltrue([
      for k in keys(var.environment_variables) :
      !can(regex("(?i)(SECRET|PASSWORD|PASSWD|TOKEN|PRIVATE|SERVICE_ROLE|API_KEY|_KEY$|HASH$)", k))
    ])
    error_message = "Secret-looking environment variable names are not allowed; store secrets in SSM Parameter Store."
  }
}

variable "application_log_level" {
  description = "Minimum application log level captured in JSON logs"
  type        = string
  default     = "INFO"
}

variable "log_retention_days" {
  description = "CloudWatch log retention for the function"
  type        = number
  default     = 90
}

variable "log_kms_key_arn" {
  description = "Optional customer-managed KMS key for the log group"
  type        = string
  default     = null
}

variable "ssm_parameter_path" {
  description = "SSM path prefix, with leading and trailing slash, e.g. /pitchnest/prod/"
  type        = string

  validation {
    condition     = can(regex("^/[A-Za-z0-9_./-]+/$", var.ssm_parameter_path))
    error_message = "ssm_parameter_path must start and end with '/'."
  }
}

variable "ssm_parameter_names" {
  description = "Exact parameter names (under ssm_parameter_path) the function may read"
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for n in var.ssm_parameter_names : can(regex("^[A-Za-z0-9_.-]+$", n))])
    error_message = "Parameter names must be plain names without slashes or wildcards."
  }
}

variable "ssm_kms_key_arn" {
  description = "Customer-managed KMS key ARN encrypting the SecureStrings (null when using alias/aws/ssm)"
  type        = string
  default     = null
}

variable "alias_name" {
  description = "Alias that serves traffic"
  type        = string
  default     = "live"
}
