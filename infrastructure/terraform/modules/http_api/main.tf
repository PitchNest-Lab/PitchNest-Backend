# HTTP API that proxies every route to a Lambda ALIAS (never $LATEST), with
# stage throttling and structured JSON access logs.
#
# HTTP APIs write access logs through a service-linked role, so no account-
# level API Gateway CloudWatch role is required.

resource "aws_apigatewayv2_api" "this" {
  name                         = var.api_name
  protocol_type                = "HTTP"
  description                  = var.description
  disable_execute_api_endpoint = var.disable_execute_api_endpoint
}

resource "aws_cloudwatch_log_group" "access" {
  name              = "/aws/apigateway/${var.api_name}/access"
  retention_in_days = var.access_log_retention_days
  kms_key_id        = var.log_kms_key_arn
}

resource "aws_apigatewayv2_integration" "lambda" {
  api_id                 = aws_apigatewayv2_api.this.id
  integration_type       = "AWS_PROXY"
  integration_method     = "POST"
  integration_uri        = var.lambda_alias_invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = var.integration_timeout_ms
}

resource "aws_apigatewayv2_route" "default" {
  api_id    = aws_apigatewayv2_api.this.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

resource "aws_apigatewayv2_stage" "this" {
  api_id      = aws_apigatewayv2_api.this.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_burst_limit   = var.throttling_burst_limit
    throttling_rate_limit    = var.throttling_rate_limit
    detailed_metrics_enabled = var.detailed_metrics_enabled
  }

  # One JSON object per request. Deliberately excludes headers, query strings
  # and bodies ($context.path has no query string), so bearer tokens, file
  # tokens and payloads never reach the access log.
  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.access.arn
    format = jsonencode({
      requestId          = "$context.requestId"
      requestTime        = "$context.requestTimeEpoch"
      sourceIp           = "$context.identity.sourceIp"
      userAgent          = "$context.identity.userAgent"
      httpMethod         = "$context.httpMethod"
      path               = "$context.path"
      routeKey           = "$context.routeKey"
      protocol           = "$context.protocol"
      status             = "$context.status"
      responseLength     = "$context.responseLength"
      responseLatency    = "$context.responseLatency"
      integrationStatus  = "$context.integrationStatus"
      integrationLatency = "$context.integrationLatency"
      integrationError   = "$context.integrationErrorMessage"
      errorMessage       = "$context.error.message"
    })
  }
}

# Allow this API (any stage/route) to invoke ONLY the traffic alias.
resource "aws_lambda_permission" "invoke_alias" {
  statement_id  = "AllowHttpApiInvoke-${var.lambda_alias_name}"
  action        = "lambda:InvokeFunction"
  function_name = var.lambda_function_name
  qualifier     = var.lambda_alias_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.this.execution_arn}/*/*"
}
