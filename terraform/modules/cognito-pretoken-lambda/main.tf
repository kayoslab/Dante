/**
 * Cognito Pre Token Generation V3 Lambda module.
 *
 * Provisions the function + IAM + CloudWatch log group + the
 * `lambda:InvokeFunction` permission Cognito needs to call it on every
 * token issuance. Distinct from the sync Lambda module because:
 *   - No VPC (the Lambda doesn't touch RDS or any private resource).
 *   - No Secrets Manager grants.
 *   - No EventBridge schedule.
 *   - Different concurrency posture — invoked synchronously by
 *     Cognito on the sign-in / refresh hot path; cold-start latency
 *     is on the user-visible budget. Reserved concurrency = 5 so it
 *     stays warm.
 *
 * The function is wired to the user pool from outside the module — the
 * caller passes `module.cognito_pretoken_lambda.function_arn` into
 * the cognito module's `pre_token_generation_lambda_arn` variable.
 */

locals {
  function_name = "${var.name_prefix}-${var.environment}-cognito-pretoken"
}

# --- IAM role -------------------------------------------------------------

resource "aws_iam_role" "lambda" {
  name = "${local.function_name}-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

# CloudWatch Logs.
resource "aws_iam_role_policy_attachment" "logs" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# --- Lambda function ------------------------------------------------------

resource "aws_lambda_function" "this" {
  function_name    = local.function_name
  role             = aws_iam_role.lambda.arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "lambda.handler"
  filename         = var.package_zip_path
  source_code_hash = filebase64sha256(var.package_zip_path)
  memory_size      = 128
  # Cognito's PreTokenGen synchronous timeout is 5s; the function does
  # an in-memory map lookup and returns, so even 1s is generous.
  timeout = 3

  # Keep warm — token issuance is in the user-facing sign-in path.
  reserved_concurrent_executions = var.reserved_concurrent_executions

  tags = {
    SourceHash = var.package_source_hash
  }
}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/aws/lambda/${local.function_name}"
  retention_in_days = 30
}

# Cognito → Lambda invoke permission lives at the ENV level, not in
# this module, to break a module-level dependency cycle:
#
#   cognito module needs   pre_token_generation_lambda_arn
#   this module would need user_pool_arn (for SourceArn on the permission)
#
# Each output is consumed by the other → HCL refuses. The env stack
# pulls both outputs and declares a single aws_lambda_permission
# alongside the module calls — clean linear ordering. See the matching
# block in `terraform/envs/prod/main.tf`.
