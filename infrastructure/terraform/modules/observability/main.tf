# Alarms for a Lambda alias behind an HTTP API, published to an SNS topic.
# Missing data is treated as "not breaching" so idle periods are quiet.
#
# Topic encryption: the AWS-managed alias/aws/sns key CANNOT be used here —
# its key policy is immutable and does not let the CloudWatch service generate
# data keys, so alarm notifications would fail silently. The topic is left
# unencrypted by default (alarm payloads carry only alarm/metric metadata, no
# secrets or personal data) and protected by a least-privilege topic policy.
# Pass a customer-managed key via sns_kms_key_arn if a control requires SSE;
# that key's policy must allow cloudwatch.amazonaws.com kms:GenerateDataKey*
# and kms:Decrypt.

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}
data "aws_partition" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition
  region     = data.aws_region.current.region

  # Every alarm in this module is named "<name_prefix>-..."; the topic accepts
  # publishes only from alarms matching this ARN prefix.
  alarm_arn_pattern = "arn:${local.partition}:cloudwatch:${local.region}:${local.account_id}:alarm:${var.name_prefix}-*"

  # Lambda publishes alias-level metrics with Resource = "<function>:<alias>".
  lambda_alias_dimensions = {
    FunctionName = var.lambda_function_name
    Resource     = "${var.lambda_function_name}:${var.lambda_alias_name}"
  }
  api_dimensions = {
    ApiId = var.api_id
    Stage = var.api_stage
  }
  alarm_actions = [aws_sns_topic.alarms.arn]
}

resource "aws_sns_topic" "alarms" {
  name              = "${var.name_prefix}-alarms"
  kms_master_key_id = var.sns_kms_key_arn
}

data "aws_iam_policy_document" "alarm_topic" {
  # Account administration of the topic, delegated to IAM in this account.
  # Publish is deliberately NOT included: only the alarms below may publish.
  statement {
    sid    = "AllowAccountAdministration"
    effect = "Allow"
    actions = [
      "sns:GetTopicAttributes",
      "sns:SetTopicAttributes",
      "sns:AddPermission",
      "sns:RemovePermission",
      "sns:DeleteTopic",
      "sns:Subscribe",
      "sns:ListSubscriptionsByTopic",
    ]
    resources = [aws_sns_topic.alarms.arn]

    principals {
      type        = "AWS"
      identifiers = ["arn:${local.partition}:iam::${local.account_id}:root"]
    }
  }

  # CloudWatch alarms from THIS account whose names carry this module's prefix.
  statement {
    sid       = "AllowOwnCloudWatchAlarmsToPublish"
    effect    = "Allow"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alarms.arn]

    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = [local.alarm_arn_pattern]
    }
  }

  # Topic policies only accept topic-scoped actions; a wildcard ("sns:*")
  # expands to account-level actions (CreateTopic, ListTopics, ...) and SNS
  # rejects the policy with "Policy statement action out of service scope!".
  # List every topic-scoped action explicitly instead.
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"
    actions = [
      "sns:Publish",
      "sns:Subscribe",
      "sns:GetTopicAttributes",
      "sns:SetTopicAttributes",
      "sns:AddPermission",
      "sns:RemovePermission",
      "sns:DeleteTopic",
      "sns:ListSubscriptionsByTopic",
    ]
    resources = [aws_sns_topic.alarms.arn]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_sns_topic_policy" "alarms" {
  arn    = aws_sns_topic.alarms.arn
  policy = data.aws_iam_policy_document.alarm_topic.json
}

# Email subscriptions must be confirmed by the recipient after apply.
resource "aws_sns_topic_subscription" "email" {
  for_each  = toset(var.alarm_email_endpoints)
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = each.value
}

resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  alarm_name          = "${var.name_prefix}-lambda-errors"
  alarm_description   = "Unhandled Lambda errors on the ${var.lambda_alias_name} alias"
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = local.lambda_alias_dimensions
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.lambda_error_threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  actions_enabled     = var.alarm_actions_enabled
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "lambda_throttles" {
  alarm_name          = "${var.name_prefix}-lambda-throttles"
  alarm_description   = "Lambda throttling on the ${var.lambda_alias_name} alias (concurrency exhausted)"
  namespace           = "AWS/Lambda"
  metric_name         = "Throttles"
  dimensions          = local.lambda_alias_dimensions
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  actions_enabled     = var.alarm_actions_enabled
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "lambda_duration_p95" {
  alarm_name          = "${var.name_prefix}-lambda-duration-p95"
  alarm_description   = "p95 duration approaching the ${var.lambda_timeout_seconds}s timeout"
  namespace           = "AWS/Lambda"
  metric_name         = "Duration"
  dimensions          = local.lambda_alias_dimensions
  extended_statistic  = "p95"
  period              = 300
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  threshold           = var.lambda_timeout_seconds * 1000 * 0.8
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  actions_enabled     = var.alarm_actions_enabled
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "api_5xx" {
  alarm_name          = "${var.name_prefix}-api-5xx"
  alarm_description   = "HTTP API 5xx responses per 5 min >= ${var.api_5xx_threshold}. Includes INTENTIONAL 503s (pre-release placeholder; billing_unavailable / Google sign-in not configured) as well as integration errors and timeouts. Lambda Errors is the primary failure signal."
  namespace           = "AWS/ApiGateway"
  metric_name         = "5xx"
  dimensions          = local.api_dimensions
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.api_5xx_threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  actions_enabled     = var.alarm_actions_enabled
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "api_latency_p95" {
  alarm_name          = "${var.name_prefix}-api-latency-p95"
  alarm_description   = "HTTP API p95 latency"
  namespace           = "AWS/ApiGateway"
  metric_name         = "Latency"
  dimensions          = local.api_dimensions
  extended_statistic  = "p95"
  period              = 300
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  threshold           = var.api_latency_p95_ms
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  actions_enabled     = var.alarm_actions_enabled
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}
