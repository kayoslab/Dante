/**
 * Sync Lambda module.
 *
 * Packages `lib/sync/lambda.ts` as a Node 22 Lambda, wires the IAM role
 * for Secrets Manager + RDS + CloudWatch Logs, and (optionally) creates
 * an EventBridge schedule that fires on a cron.
 *
 * Build: the zip is produced out-of-band by `npm run build:sync-lambda`
 * (esbuild bundles, jsonwriter zips). Terraform consumes the zip path —
 * it doesn't shell out to esbuild itself, so a `terraform apply` is
 * pure infra mutation, not a build step.
 */

locals {
  function_name = "${var.name_prefix}-${var.environment}-sync"
}

# --- IAM role + policy ------------------------------------------------------

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

# VPC execution (only if VPC config is provided).
resource "aws_iam_role_policy_attachment" "vpc" {
  count      = var.vpc_config == null ? 0 : 1
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

# Secrets Manager read access. Two distinct concerns:
#   - App secrets (Personio, awork) — `var.secret_arns`.
#   - RDS master credentials (managed secret) — `var.database_secret_arn`.
# Both grants live on the same role; the policy is the only place that
# combines them so additions/removals are visible together.
data "aws_iam_policy_document" "secrets" {
  statement {
    effect  = "Allow"
    actions = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
    resources = concat(
      var.secret_arns,
      var.database_secret_arn == null ? [] : [var.database_secret_arn],
    )
  }
  # KMS decrypt on the app secrets' customer-managed key (no-op when null —
  # the AWS-managed Secrets Manager key authorizes implicitly).
  dynamic "statement" {
    for_each = var.kms_key_arn == null ? [] : [var.kms_key_arn]
    content {
      effect    = "Allow"
      actions   = ["kms:Decrypt", "kms:DescribeKey"]
      resources = [statement.value]
    }
  }
  # Separate grant for the RDS secret's KMS key (when set). RDS may use
  # a different key than the app secrets; the IAM separation keeps the
  # blast radius scoped.
  dynamic "statement" {
    for_each = var.database_secret_kms_key_arn == null ? [] : [var.database_secret_kms_key_arn]
    content {
      effect    = "Allow"
      actions   = ["kms:Decrypt", "kms:DescribeKey"]
      resources = [statement.value]
    }
  }
}

resource "aws_iam_role_policy" "secrets" {
  name   = "${local.function_name}-secrets"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.secrets.json
}

# --- Lambda function -------------------------------------------------------

resource "aws_lambda_function" "sync" {
  function_name                  = local.function_name
  role                           = aws_iam_role.lambda.arn
  runtime                        = "nodejs22.x"
  architectures                  = ["arm64"]
  handler                        = "lambda.handler"
  filename                       = var.package_zip_path
  source_code_hash               = filebase64sha256(var.package_zip_path)
  memory_size                    = var.memory_size
  timeout                        = var.timeout
  reserved_concurrent_executions = var.reserved_concurrent_executions

  # Cross-field guard: RDS for any non-local env lives in a private
  # subnet, so the Lambda needs VPC config to reach it. A null vpc_config
  # in dev/prod silently deploys a Lambda that can't connect — the sync
  # would run, fail to open a DB connection, and burn 300s of timeout
  # before the alarm catches it. Fail at plan time instead.
  lifecycle {
    precondition {
      condition = (
        var.environment == "local"
        || var.skip_vpc_check
        || var.vpc_config != null
      )
      error_message = "vpc_config is required when environment != \"local\". Pass subnet_ids + security_group_ids of the private subnets that can reach RDS, or set skip_vpc_check = true if you're intentionally deploying a Lambda that doesn't need DB access."
    }
  }

  environment {
    variables = merge(
      {
        DANTE_ENV                 = var.environment
        DANTE_USE_SECRETS_MANAGER = "1"
        DANTE_LOG_LEVEL           = "info"
        # AWS_REGION is reserved by the Lambda runtime — it injects the
        # function's region automatically and rejects an explicit value.
        # The SDK reads it the same way either way.
        NODE_ENV                  = "production"
      },
      # DB config — the Lambda runtime fetches credentials from the
      # managed secret, then composes DATABASE_URL using the host/db/port
      # below. Plaintext stays out of env vars; only the pointers are here.
      var.database_secret_arn == null ? {} : {
        DANTE_DATABASE_SECRET_ARN = var.database_secret_arn
        DANTE_DATABASE_ENDPOINT   = var.database_endpoint
        DANTE_DATABASE_NAME       = var.database_name
      },
    )
  }

  dynamic "vpc_config" {
    for_each = var.vpc_config == null ? [] : [var.vpc_config]
    content {
      subnet_ids         = vpc_config.value.subnet_ids
      security_group_ids = vpc_config.value.security_group_ids
    }
  }

  # source_code_hash above already ties to the zip contents, but the
  # extra hash variable lets callers force a redeploy without rebuilding
  # (e.g. when only IAM changes).
  tags = {
    SourceHash = var.package_source_hash
  }
}

resource "aws_cloudwatch_log_group" "sync" {
  name              = "/aws/lambda/${local.function_name}"
  retention_in_days = 30
}

# --- EventBridge schedule --------------------------------------------------

resource "aws_cloudwatch_event_rule" "schedule" {
  count               = var.schedule_expression == "" ? 0 : 1
  name                = "${local.function_name}-schedule"
  description         = "Scheduled invocation of the ${local.function_name} Lambda."
  schedule_expression = var.schedule_expression
}

resource "aws_cloudwatch_event_target" "schedule" {
  count = var.schedule_expression == "" ? 0 : 1
  rule  = aws_cloudwatch_event_rule.schedule[0].name
  arn   = aws_lambda_function.sync.arn
  input = var.schedule_input_json
}

resource "aws_lambda_permission" "schedule" {
  count         = var.schedule_expression == "" ? 0 : 1
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.sync.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.schedule[0].arn
}

# --- Dead-letter queue + retry config ---------------------------------------
#
# EventBridge defaults to discarding events after 2 retries. For a
# scheduled HR sync, silent failure is unacceptable — a single missed
# run is up to 24h of stale salary / time data. The DLQ catches events
# the Lambda failed to process; the CloudWatch alarm below pages an
# operator when the queue is non-empty.

resource "aws_sqs_queue" "dlq" {
  name                      = "${local.function_name}-dlq"
  message_retention_seconds = var.dlq_message_retention_seconds
  # No KMS encryption: the queued payload is the EventBridge input JSON,
  # which contains only sync flags, not credentials. Add server-side
  # encryption with a CMK if that changes.
}

resource "aws_iam_role_policy" "dlq" {
  name = "${local.function_name}-dlq-send"
  role = aws_iam_role.lambda.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "sqs:SendMessage"
      Resource = aws_sqs_queue.dlq.arn
    }]
  })
}

# Lambda async-invoke DLQ: catches errors thrown by the handler itself
# (vs. EventBridge delivery errors, which are vanishingly rare and have
# their own AWS-managed retry). For a scheduled job, the async-invoke
# config below is what catches a `runSync` rejection / unhandled throw.
resource "aws_lambda_function_event_invoke_config" "sync" {
  function_name                = aws_lambda_function.sync.function_name
  maximum_retry_attempts       = 1
  maximum_event_age_in_seconds = 3600

  destination_config {
    on_failure {
      destination = aws_sqs_queue.dlq.arn
    }
  }
}

# --- Alarm SNS topic --------------------------------------------------------

resource "aws_sns_topic" "alarms" {
  name = "${local.function_name}-alarms"
}

resource "aws_sns_topic_subscription" "alarms_email" {
  for_each  = toset(var.alarm_email_addresses)
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = each.value
}

# --- CloudWatch alarms ------------------------------------------------------

locals {
  # Page when the run takes longer than 80% of the timeout — gives time
  # to investigate before the next scheduled invocation lands.
  duration_alarm_threshold_ms = floor(var.timeout * 1000 * 0.8)
}

resource "aws_cloudwatch_metric_alarm" "errors" {
  alarm_name          = "${local.function_name}-errors"
  alarm_description   = "Sync Lambda invocation failed (handler threw, runtime crashed, or initialization failed). Check the CloudWatch log group and the SQS DLQ."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.sync.function_name
  }

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "throttles" {
  alarm_name          = "${local.function_name}-throttles"
  alarm_description   = "Sync Lambda was throttled — concurrency cap was hit. Either the prior run is still in-flight (investigate why) or the reserved_concurrent_executions is too low for the schedule."
  namespace           = "AWS/Lambda"
  metric_name         = "Throttles"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.sync.function_name
  }

  alarm_actions = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "duration" {
  alarm_name          = "${local.function_name}-slow"
  alarm_description   = "Sync Lambda is approaching its timeout (>80% used). Likely cause: upstream API latency or DB connection thrash. If you don't act, the next run may time out and trigger the errors alarm."
  namespace           = "AWS/Lambda"
  metric_name         = "Duration"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = local.duration_alarm_threshold_ms
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.sync.function_name
  }

  alarm_actions = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "dlq_depth" {
  alarm_name          = "${local.function_name}-dlq-not-empty"
  alarm_description   = "Sync Lambda DLQ has unprocessed messages — one or more invocations failed and were captured for replay. Inspect via `aws sqs receive-message --queue-url ${aws_sqs_queue.dlq.url}` and either re-invoke the Lambda or purge after fixing the root cause."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.dlq.name
  }

  alarm_actions = [aws_sns_topic.alarms.arn]
}

data "aws_region" "current" {}
