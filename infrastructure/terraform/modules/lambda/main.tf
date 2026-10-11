resource "aws_lambda_function" "this" {
  function_name = var.function_name
  role          = var.execution_role_arn

  runtime = var.runtime
  handler = var.handler

  memory_size = var.memory_size
  timeout     = var.timeout

  # Application package supplied by the deployment pipeline.
  filename         = var.deployment_package
  source_code_hash = filebase64sha256(var.deployment_package)

  environment {
    variables = var.environment_variables
  }

  # Temporary protection while migrating environment
  # variables to centralized secrets management.
  lifecycle {
    ignore_changes = [
      environment,
       filename,
       source_code_hash,
    ]
  }
}