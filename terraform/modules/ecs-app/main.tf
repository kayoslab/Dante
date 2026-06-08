/**
 * ECS Fargate service for the Next.js app.
 *
 * Shape:
 *   - Cluster — Fargate-only (no EC2 capacity providers).
 *   - Task definition — single container, fed by ECR.
 *   - Service — desired_count tasks behind the ALB target group.
 *
 * IAM:
 *   - execution role  — ECS uses this to pull from ECR + write logs +
 *                       resolve `secrets` entries.
 *   - task role       — the running container uses this to call AWS APIs
 *                       (Secrets Manager fetches for credentials it
 *                       composes lazily, etc.).
 *
 * Deploys: rolling update, min=100 / max=200 by default = zero downtime.
 * The CI pipeline drops a new image tag, updates the task definition
 * (out of band) and triggers `aws ecs update-service --force-new-deployment`.
 */

locals {
  name = "${var.name_prefix}-${var.environment}-app"
}

# --- Cluster ---------------------------------------------------------------

resource "aws_ecs_cluster" "this" {
  name = local.name

  setting {
    name  = "containerInsights"
    value = "enhanced" # 2.0; richer metrics, similar cost to v1 ("enabled")
  }

  tags = {
    Name = local.name
  }
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
    base              = 1
  }
}

# --- Log group -------------------------------------------------------------

resource "aws_cloudwatch_log_group" "app" {
  name              = "/aws/ecs/${local.name}"
  retention_in_days = var.log_retention_days
}

# --- IAM: execution role (ECS-side) ---------------------------------------

data "aws_iam_policy_document" "execution_assume" {
  statement {
    effect = "Allow"
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
    actions = ["sts:AssumeRole"]
  }
}

resource "aws_iam_role" "execution" {
  name               = "${local.name}-exec"
  assume_role_policy = data.aws_iam_policy_document.execution_assume.json
}

# Default ECS execution policy — covers ECR pull + log writes.
resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Allow execution role to resolve `secrets` entries. Scoped to exactly
# the ARNs declared in var.secrets (no wildcards).
data "aws_iam_policy_document" "execution_secrets" {
  count = length(var.secrets) == 0 && length(var.additional_secret_arns_readable) == 0 ? 0 : 1

  statement {
    effect  = "Allow"
    actions = ["secretsmanager:GetSecretValue", "ssm:GetParameters"]
    # `value_from` may include `:key::` — strip that suffix for the IAM
    # resource. Resource ARNs in IAM don't accept the JSONPath suffix.
    resources = distinct(concat(
      [for s in var.secrets : split(":", s.value_from)[0] == "arn" ? join(":", slice(split(":", s.value_from), 0, 7)) : s.value_from],
      var.additional_secret_arns_readable,
    ))
  }

  dynamic "statement" {
    for_each = length(var.additional_kms_key_arns_decryptable) == 0 ? [] : [1]
    content {
      effect    = "Allow"
      actions   = ["kms:Decrypt", "kms:DescribeKey"]
      resources = var.additional_kms_key_arns_decryptable
    }
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  count  = length(data.aws_iam_policy_document.execution_secrets) == 0 ? 0 : 1
  name   = "${local.name}-exec-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secrets[0].json
}

# --- IAM: task role (container-side) --------------------------------------

resource "aws_iam_role" "task" {
  name               = "${local.name}-task"
  assume_role_policy = data.aws_iam_policy_document.execution_assume.json # same trust
}

# Container-side secrets access. The Next.js process resolves additional
# secrets at runtime (e.g. rotated tokens it doesn't have at boot).
resource "aws_iam_role_policy" "task_secrets" {
  count = length(var.additional_secret_arns_readable) == 0 ? 0 : 1
  name  = "${local.name}-task-secrets"
  role  = aws_iam_role.task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [{
        Effect = "Allow"
        Action = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
        Resource = var.additional_secret_arns_readable
      }],
      length(var.additional_kms_key_arns_decryptable) == 0 ? [] : [{
        Effect = "Allow"
        Action = ["kms:Decrypt", "kms:DescribeKey"]
        Resource = var.additional_kms_key_arns_decryptable
      }],
    )
  })
}

# --- Task definition ------------------------------------------------------

data "aws_region" "current" {}

locals {
  container_environment = [
    for k, v in var.environment_variables : { name = k, value = v }
  ]
  container_secrets = [
    for s in var.secrets : { name = s.name, valueFrom = s.value_from }
  ]
}

resource "aws_ecs_task_definition" "this" {
  family                   = local.name
  network_mode             = "awsvpc" # required for Fargate
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  container_definitions = jsonencode([{
    name      = "app"
    image     = var.image_uri
    essential = true

    portMappings = [{
      containerPort = var.container_port
      protocol      = "tcp"
    }]

    environment = local.container_environment
    secrets     = local.container_secrets

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.app.name
        awslogs-region        = data.aws_region.current.name
        awslogs-stream-prefix = "app"
      }
    }

    readonlyRootFilesystem = false
    # Next.js writes .next/cache at runtime if not pre-built; keeping
    # the FS writable is the simplest path. Lock down later by
    # mounting an ephemeral volume on /tmp + /app/.next/cache only.

    healthCheck = {
      command     = ["CMD-SHELL", "wget -q -O- http://localhost:${var.container_port}/api/auth/csrf || exit 1"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 30
    }
  }])

  tags = {
    Name = local.name
  }
}

# --- Service --------------------------------------------------------------

resource "aws_ecs_service" "this" {
  name                              = local.name
  cluster                           = aws_ecs_cluster.this.id
  task_definition                   = aws_ecs_task_definition.this.arn
  desired_count                     = var.desired_count
  launch_type                       = "FARGATE"
  platform_version                  = "LATEST"
  health_check_grace_period_seconds = var.health_check_grace_period_seconds
  enable_execute_command            = true # ECS Exec for live debugging — IAM-gated

  deployment_minimum_healthy_percent = var.deployment_min_healthy_percent
  deployment_maximum_percent         = var.deployment_max_percent
  deployment_circuit_breaker {
    enable   = true
    rollback = true # auto-rollback on failed deploys
  }

  network_configuration {
    subnets          = var.app_subnet_ids
    security_groups  = [var.task_security_group_id]
    assign_public_ip = false # tasks are in private subnets
  }

  load_balancer {
    target_group_arn = var.target_group_arn
    container_name   = "app"
    container_port   = var.container_port
  }

  # Don't recreate the service every time CI bumps the image tag — the
  # CI pipeline updates the task definition out of band.
  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }
}
