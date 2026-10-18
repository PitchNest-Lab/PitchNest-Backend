# Lambda service with an OWNED, least-privilege execution role, a managed log
# group, versioned publishing and a "live" alias for zero-rebuild rollback.
#
# Ownership model:
#   - Terraform owns infrastructure and NON-SECRET configuration (environment
#     variables, memory, timeout, concurrency, logging).
#   - The deployment pipeline owns CODE: it uploads a reviewed artifact,
#     publishes a version and moves the alias. Terraform therefore ignores code
#     fields and the alias' function_version after creation.
#   - Secret VALUES live only in SSM Parameter Store and are never read by
#     Terraform (no data sources on secret parameters => nothing in state).

data "aws_partition" "current" {}
data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  partition  = data.aws_partition.current.partition
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.region

  log_group_name = "/aws/lambda/${var.function_name}"
  role_name      = coalesce(var.role_name, "${var.function_name}-execution")

  ssm_parameter_arns = [
    for name in var.ssm_parameter_names :
    "arn:${local.partition}:ssm:${local.region}:${local.account_id}:parameter${var.ssm_parameter_path}${name}"
  ]
}

# ── Logging ────────────────────────────────────────────────────────────────

resource "aws_cloudwatch_log_group" "this" {
  name              = local.log_group_name
  retention_in_days = var.log_retention_days
  kms_key_id        = var.log_kms_key_arn
}

# ── Execution role (least privilege) ───────────────────────────────────────

data "aws_iam_policy_document" "assume" {
  statement {
    sid     = "LambdaAssumeRole"
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "this" {
  name                 = local.role_name
  description          = "Execution role for ${var.function_name} (managed by Terraform)"
  assume_role_policy   = data.aws_iam_policy_document.assume.json
  permissions_boundary = var.permissions_boundary_arn
  max_session_duration = 3600
}

data "aws_iam_policy_document" "permissions" {
  # Write to THIS function's log group only. The group is created by
  # Terraform, so logs:CreateLogGroup is intentionally not granted.
  statement {
    sid       = "WriteOwnLogs"
    effect    = "Allow"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.this.arn}:*"]
  }

  # Read exactly the configuration parameters the app loads at cold start
  # (src/config/loadAwsParameters.ts uses GetParameters only). No wildcards.
  dynamic "statement" {
    for_each = length(local.ssm_parameter_arns) > 0 ? [1] : []
    content {
      sid       = "ReadOwnConfigParameters"
      effect    = "Allow"
      actions   = ["ssm:GetParameters"]
      resources = local.ssm_parameter_arns
    }
  }

  # Only needed when the SecureStrings use a customer-managed KMS key. The
  # AWS-managed alias/aws/ssm key needs no IAM statement. Restricted to
  # decryption performed by SSM in this region.
  dynamic "statement" {
    for_each = var.ssm_kms_key_arn == null ? [] : [1]
    content {
      sid       = "DecryptConfigViaSsm"
      effect    = "Allow"
      actions   = ["kms:Decrypt"]
      resources = [var.ssm_kms_key_arn]
      condition {
        test     = "StringEquals"
        variable = "kms:ViaService"
        values   = ["ssm.${local.region}.amazonaws.com"]
      }
    }
  }
}

resource "aws_iam_role_policy" "this" {
  name   = "${var.function_name}-runtime"
  role   = aws_iam_role.this.id
  policy = data.aws_iam_policy_document.permissions.json
}

# ── Function ───────────────────────────────────────────────────────────────

resource "aws_lambda_function" "this" {
  function_name = var.function_name
  description   = var.description
  role          = aws_iam_role.this.arn

  runtime       = var.runtime
  handler       = var.handler
  architectures = [var.architecture]
  memory_size   = var.memory_size
  timeout       = var.timeout

  # Initial code only (a reviewed placeholder in the repo). Real releases are
  # deployed by the pipeline; see lifecycle.ignore_changes below.
  filename         = var.bootstrap_package_path
  source_code_hash = var.bootstrap_package_hash

  # Every configuration change produces an immutable version. Live traffic
  # only moves when the alias is moved (pipeline or rollback), so a Terraform
  # config change never silently alters what users hit.
  publish = true

  reserved_concurrent_executions = var.reserved_concurrency

  environment {
    variables = var.environment_variables
  }

  logging_config {
    log_format            = "JSON"
    log_group             = aws_cloudwatch_log_group.this.name
    application_log_level = var.application_log_level
    system_log_level      = "WARN"
  }

  depends_on = [
    aws_iam_role_policy.this,
    aws_cloudwatch_log_group.this,
  ]

  lifecycle {
    # Code is owned by the deployment pipeline after creation.
    ignore_changes = [
      filename,
      source_code_hash,
      s3_bucket,
      s3_key,
      s3_object_version,
    ]
  }
}

resource "aws_lambda_alias" "live" {
  name             = var.alias_name
  description      = "Version serving production traffic. Moved by the pipeline; move back to roll back."
  function_name    = aws_lambda_function.this.function_name
  function_version = aws_lambda_function.this.version

  lifecycle {
    # The pipeline (deploy) and operators (rollback) own the pointer.
    ignore_changes = [function_version, routing_config]
  }
}
