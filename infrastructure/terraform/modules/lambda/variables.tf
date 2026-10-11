variable "function_name" {
  description = "Name of the Lambda function"
  type        = string
}

variable "execution_role_arn" {
  description = "ARN of the IAM role assumed by the Lambda function"
  type        = string
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

variable "memory_size" {
  description = "Memory allocated to the Lambda function in MB"
  type        = number
  default     = 512
}

variable "timeout" {
  description = "Lambda timeout in seconds"
  type        = number
  default     = 30
}

variable "environment_variables" {
  description = "Environment variables passed to the Lambda function"
  type        = map(string)
  default     = {}
}

variable "deployment_package" {
  description = "Path to the Lambda deployment ZIP package"
  type        = string
}
