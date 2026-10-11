variable "project_name" {
  description = "Name of the project"
  type        = string
  default     = "PitchNest"
}

variable "environment" {
  description = "Deployment environment"
  type        = string
  default     = "dev"
}

variable "aws_region" {
  description = "AWS region for PitchNest resources"
  type        = string
  default     = "eu-west-2"
}