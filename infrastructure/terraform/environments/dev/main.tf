data "aws_iam_role" "lambda_execution" {
  name = "PitchNest-Dev-LambdaExecutionRole"
}

module "api_lambda" {
  source = "../../modules/lambda"

  function_name      = "pitchnest-dev-api"
  execution_role_arn = data.aws_iam_role.lambda_execution.arn

  runtime     = "nodejs22.x"
  memory_size = 512
  timeout     = 30

  deployment_package = "${path.module}/../../../../dist/pitchnest-api.zip"

  environment_variables = {
    NODE_ENV = "development"
  }
}

module "api_gateway" {
  source = "../../modules/api_gateway"

  api_name             = "pitchnest-dev-api"
  lambda_invoke_arn    = module.api_lambda.invoke_arn
  lambda_function_name = module.api_lambda.function_name
}




resource "aws_iam_role_policy" "lambda_ssm_jwt" {
  name = "PitchNest-Dev-ReadJwtParameter"
  role = data.aws_iam_role.lambda_execution.name

  policy = jsonencode({
    Version = "2012-10-17"

    Statement = [
      {
        Sid    = "ReadPitchNestDevParameters"
        Effect = "Allow"

        Action = [
          "ssm:GetParameter",
          "ssm:GetParameters"
        ]

        Resource = [
          "arn:aws:ssm:eu-west-2:639324724698:parameter/pitchnest/dev/JWT_SECRET",
          "arn:aws:ssm:eu-west-2:639324724698:parameter/pitchnest/dev/SUPABASE_SERVICE_ROLE_KEY",
          "arn:aws:ssm:eu-west-2:639324724698:parameter/pitchnest/dev/RESEND_API_KEY",
          "arn:aws:ssm:eu-west-2:639324724698:parameter/pitchnest/dev/SUPABASE_ANON_KEY",
          "arn:aws:ssm:eu-west-2:639324724698:parameter/pitchnest/dev/SUPABASE_URL",
          "arn:aws:ssm:eu-west-2:639324724698:parameter/pitchnest/dev/GOOGLE_CLIENT_ID"
        ]
      }
    ]
  })
}
