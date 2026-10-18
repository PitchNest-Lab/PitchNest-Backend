output "api_endpoint" {
  description = "PROD execute-api endpoint (not wired to the frontend; disabled until api_public_endpoint_enabled = true)"
  value       = module.api_gateway.api_endpoint
}

output "api_public_endpoint_enabled" {
  description = "Whether the default execute-api endpoint is enabled"
  value       = var.api_public_endpoint_enabled
}

output "alarm_notifications_enabled" {
  description = "Whether alarm notifications are sent"
  value       = module.observability.alarm_actions_enabled
}

output "function_name" {
  description = "PROD Lambda function"
  value       = module.api_lambda.function_name
}

output "live_alias_arn" {
  description = "Alias serving API traffic"
  value       = module.api_lambda.alias_arn
}

output "execution_role_arn" {
  description = "Dedicated execution role"
  value       = module.api_lambda.execution_role_arn
}

output "lambda_log_group" {
  description = "Function log group"
  value       = module.api_lambda.log_group_name
}

output "api_access_log_group" {
  description = "API access log group"
  value       = module.api_gateway.access_log_group_name
}

output "alarm_topic_arn" {
  description = "SNS topic for alarms"
  value       = module.observability.alarm_topic_arn
}

output "rollback_command" {
  description = "Point the live alias at a previous version (replace <VERSION>)"
  value       = "aws lambda update-alias --function-name ${module.api_lambda.function_name} --name ${module.api_lambda.alias_name} --function-version <VERSION> --profile pitchnest-prod --region eu-west-2"
}
