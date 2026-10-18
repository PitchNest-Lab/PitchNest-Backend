output "alarm_topic_arn" {
  description = "SNS topic receiving alarm notifications"
  value       = aws_sns_topic.alarms.arn
}

output "alarm_actions_enabled" {
  description = "Whether alarm notifications are currently sent"
  value       = var.alarm_actions_enabled
}

output "alarm_names" {
  description = "CloudWatch alarm names"
  value = [
    aws_cloudwatch_metric_alarm.lambda_errors.alarm_name,
    aws_cloudwatch_metric_alarm.lambda_throttles.alarm_name,
    aws_cloudwatch_metric_alarm.lambda_duration_p95.alarm_name,
    aws_cloudwatch_metric_alarm.api_5xx.alarm_name,
    aws_cloudwatch_metric_alarm.api_latency_p95.alarm_name,
  ]
}
