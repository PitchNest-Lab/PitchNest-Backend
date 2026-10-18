output "api_id" {
  description = "HTTP API id"
  value       = aws_apigatewayv2_api.this.id
}

output "api_endpoint" {
  description = "Default execute-api endpoint"
  value       = aws_apigatewayv2_api.this.api_endpoint
}

output "execution_arn" {
  description = "Execution ARN"
  value       = aws_apigatewayv2_api.this.execution_arn
}

output "stage_name" {
  description = "Stage name"
  value       = aws_apigatewayv2_stage.this.name
}

output "access_log_group_name" {
  description = "Access log group"
  value       = aws_cloudwatch_log_group.access.name
}
