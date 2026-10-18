output "function_name" {
  description = "Lambda function name"
  value       = aws_lambda_function.this.function_name
}

output "function_arn" {
  description = "Unqualified function ARN"
  value       = aws_lambda_function.this.arn
}

output "published_version" {
  description = "Version published by the most recent Terraform-driven change"
  value       = aws_lambda_function.this.version
}

output "alias_name" {
  description = "Traffic alias name"
  value       = aws_lambda_alias.live.name
}

output "alias_arn" {
  description = "Qualified alias ARN"
  value       = aws_lambda_alias.live.arn
}

output "alias_invoke_arn" {
  description = "Invoke ARN of the alias (used by API Gateway)"
  value       = aws_lambda_alias.live.invoke_arn
}

output "execution_role_arn" {
  description = "Execution role ARN"
  value       = aws_iam_role.this.arn
}

output "log_group_name" {
  description = "Function log group"
  value       = aws_cloudwatch_log_group.this.name
}
