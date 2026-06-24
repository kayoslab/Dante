/**
 * GitHub Actions ⇄ AWS via OpenID Connect.
 *
 * Two IAM roles:
 *   - `check`   — read-only. Assumed by PR / push workflows that just
 *                 type-check, terraform fmt + validate. No mutations.
 *   - `deploy`  — push to ECR, register + roll ECS task definitions,
 *                 update Lambda code, read/write Terraform state.
 *                 Assumed only by workflows on the protected branch
 *                 (`var.deploy_role_branch_filter`).
 *
 * The OIDC provider is one-per-account. Create it from one environment
 * (`create_oidc_provider = true`) and import it everywhere else.
 *
 * Trust policy scopes:
 *   - sub = `repo:<github_repository>:ref:refs/heads/<branch>` for the
 *     deploy role — only that branch's workflows can assume it.
 *   - sub = `repo:<github_repository>:*` for the check role — any
 *     workflow on any branch / pull request can run checks.
 *   - aud must be `sts.amazonaws.com` (required by the AWS-suggested
 *     OIDC flow used by `aws-actions/configure-aws-credentials@v4`).
 */

locals {
  name            = "${var.name_prefix}-${var.environment}-gh"
  github_oidc_url = "https://token.actions.githubusercontent.com"
}

# --- OIDC provider --------------------------------------------------------

resource "aws_iam_openid_connect_provider" "github" {
  count          = var.create_oidc_provider ? 1 : 0
  url            = local.github_oidc_url
  client_id_list = ["sts.amazonaws.com"]
  # GitHub rotated their OIDC certificate but AWS validates against the
  # JWKS at call time — the thumbprint is a deprecated relic. Include a
  # plausible value so the API accepts it; AWS ignores it for OIDC IdPs.
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]

  tags = {
    Name = "${var.name_prefix}-github-oidc"
  }
}

data "aws_iam_openid_connect_provider" "github" {
  count = var.create_oidc_provider ? 0 : 1
  url   = local.github_oidc_url
}

locals {
  oidc_arn = var.create_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : data.aws_iam_openid_connect_provider.github[0].arn
}

# --- Trust policies -------------------------------------------------------

data "aws_iam_policy_document" "check_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.oidc_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      # Any branch, any PR — workflows are read-only.
      values = ["repo:${var.github_repository}:*"]
    }
  }
}

data "aws_iam_policy_document" "deploy_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.oidc_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values = concat(
        # Branch-scoped sub for ordinary jobs (no `environment:` block
        # in the workflow). Set deploy_role_branch_filter = "*" to
        # allow any branch (NOT recommended for prod).
        [
          var.deploy_role_branch_filter == "*"
          ? "repo:${var.github_repository}:*"
          : "repo:${var.github_repository}:ref:refs/heads/${var.deploy_role_branch_filter}",
        ],
        # Environment-scoped sub for jobs that declare
        # `environment: <name>` (GitHub re-issues the OIDC token with
        # `:environment:<name>` instead of `:ref:refs/heads/<branch>`).
        # Empty list = no environment-scoped jobs allowed.
        [for env in var.deploy_role_environments : "repo:${var.github_repository}:environment:${env}"],
      )
    }
  }
}

# --- Check role (read-only) -----------------------------------------------

resource "aws_iam_role" "check" {
  name               = "${local.name}-check"
  description        = "Assumed by GitHub Actions PR / push workflows for type-check + terraform validate. Read-only AWS access."
  assume_role_policy = data.aws_iam_policy_document.check_trust.json
}

# Read-only on the relevant services. Broad scope is fine because the
# role is genuinely read-only and the trust policy is the scoping layer.
resource "aws_iam_role_policy_attachment" "check_readonly" {
  role       = aws_iam_role.check.name
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}

# --- Deploy role ----------------------------------------------------------

resource "aws_iam_role" "deploy" {
  name               = "${local.name}-deploy"
  description        = "Assumed by GitHub Actions deploy workflow (main only). Push ECR images + update ECS services + apply Terraform."
  assume_role_policy = data.aws_iam_policy_document.deploy_trust.json
}

data "aws_iam_policy_document" "deploy" {
  # ECR push (incl. token + image upload).
  statement {
    effect = "Allow"
    actions = [
      "ecr:GetAuthorizationToken",
    ]
    resources = ["*"] # GetAuthorizationToken is account-scoped only
  }

  statement {
    effect = "Allow"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:CompleteLayerUpload",
      "ecr:DescribeImages",
      "ecr:DescribeImageScanFindings",
      "ecr:DescribeRepositories",
      "ecr:GetDownloadUrlForLayer",
      "ecr:InitiateLayerUpload",
      "ecr:ListImages",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
    ]
    resources = [var.ecr_repository_arn]
  }

  # EC2 — full management on the network + compute primitives terraform
  # touches. VPC endpoints, NAT (gateway OR instance), security groups,
  # network interfaces, EIPs, EC2 instances, routes, tags. Enumerating
  # the dozen-plus required actions each time terraform grows a new
  # resource type is a maintenance treadmill; the deploy role's real
  # trust boundary is the OIDC main-branch condition. Reads come from
  # the ReadOnlyAccess attachment further down.
  statement {
    effect    = "Allow"
    actions   = ["ec2:*"]
    resources = ["*"]
  }

  # ECS — register new task definition revisions, deregister old ones
  # (terraform rotates them every apply), tag them, and force-roll
  # services. Tag/Untag are required because RegisterTaskDefinition
  # creates the rev with tags atomically — without `ecs:TagResource`
  # the whole Register call is rejected.
  statement {
    effect = "Allow"
    actions = [
      "ecs:RegisterTaskDefinition",
      "ecs:DeregisterTaskDefinition",
      "ecs:DescribeTaskDefinition",
      "ecs:ListTaskDefinitions",
      "ecs:TagResource",
      "ecs:UntagResource",
    ]
    resources = ["*"] # task-def actions have no resource-level support
  }

  statement {
    effect = "Allow"
    actions = [
      "ecs:UpdateService",
      "ecs:DescribeServices",
    ]
    resources = var.ecs_service_arns
  }

  # iam:PassRole — needed when RegisterTaskDefinition refers to the
  # execution + task roles.
  dynamic "statement" {
    for_each = length(var.task_role_arns_passable) == 0 ? [] : [1]
    content {
      effect    = "Allow"
      actions   = ["iam:PassRole"]
      resources = var.task_role_arns_passable
      condition {
        test     = "StringEquals"
        variable = "iam:PassedToService"
        values   = ["ecs-tasks.amazonaws.com"]
      }
    }
  }

  # iam:PutRolePolicy / DeleteRolePolicy on specific role ARNs — needed
  # when a module's inline policy (e.g. sync-lambda's secrets
  # statement) is modified by `terraform apply`. Scoped to the
  # explicit list so a compromised deploy token can't rewrite
  # arbitrary IAM. The deploy role's own ARN must never appear in
  # this list (would allow self-escalation).
  dynamic "statement" {
    for_each = length(var.managed_iam_role_arns) == 0 ? [] : [1]
    content {
      effect = "Allow"
      actions = [
        "iam:PutRolePolicy",
        "iam:DeleteRolePolicy",
      ]
      resources = var.managed_iam_role_arns
    }
  }

  # EventBridge rule + target maintenance. Scoped to specific rule
  # ARNs (currently just the sync Lambda's schedule). PutTargets /
  # RemoveTargets are required even though the cron expression
  # itself is on PutRule — terraform reconciles the target wiring
  # on every apply. TagResource / UntagResource are mandatory: PutRule
  # rejects calls that include tags if the principal lacks
  # events:TagResource.
  dynamic "statement" {
    for_each = length(var.eventbridge_rule_arns) == 0 ? [] : [1]
    content {
      effect = "Allow"
      actions = [
        "events:PutRule",
        "events:DeleteRule",
        "events:PutTargets",
        "events:RemoveTargets",
        "events:TagResource",
        "events:UntagResource",
      ]
      resources = var.eventbridge_rule_arns
    }
  }

  # SNS topic management. Subscribe / topic-attribute / tag actions
  # carry a resource-level ARN constraint, so they scope to the
  # specific topics terraform owns. Unsubscribe targets a subscription
  # ARN (`arn:aws:sns:region:account:topic:subscription-id`) which
  # AWS does NOT let us scope to a topic prefix — so it stays on `*`
  # but is still bounded by the OIDC trust condition.
  dynamic "statement" {
    for_each = length(var.sns_topic_arns) == 0 ? [] : [1]
    content {
      effect = "Allow"
      actions = [
        "sns:Subscribe",
        "sns:GetTopicAttributes",
        "sns:SetTopicAttributes",
        "sns:TagResource",
        "sns:UntagResource",
        "sns:ListSubscriptionsByTopic",
      ]
      resources = var.sns_topic_arns
    }
  }
  dynamic "statement" {
    for_each = length(var.sns_topic_arns) == 0 ? [] : [1]
    content {
      effect = "Allow"
      actions = [
        "sns:Unsubscribe",
        "sns:GetSubscriptionAttributes",
        "sns:SetSubscriptionAttributes",
      ]
      resources = ["*"]
    }
  }

  # Lambda — update sync Lambda's code from the rebuilt zip and let
  # terraform reconcile tags / config drift on every apply.
  dynamic "statement" {
    for_each = length(var.lambda_function_arns) == 0 ? [] : [1]
    content {
      effect = "Allow"
      actions = [
        "lambda:UpdateFunctionCode",
        "lambda:UpdateFunctionConfiguration",
        "lambda:GetFunction",
        "lambda:GetFunctionConfiguration",
        "lambda:TagResource",
        "lambda:UntagResource",
        "lambda:ListTags",
      ]
      resources = var.lambda_function_arns
    }
  }

  # Secrets Manager — narrowly scoped. Two tiers, deliberately split
  # so a compromised GitHub OIDC token can't walk away with every
  # prod credential:
  #
  # 1. `secret_arns_read_write` — secrets where terraform manages the
  #    VALUE (i.e. has an `aws_secretsmanager_secret_version`
  #    resource). Plan needs GetSecretValue to refresh-compare; apply
  #    needs PutSecretValue. In practice this is just the
  #    cognito_client_secret, which terraform writes from the Cognito
  #    module's output.
  #
  # 2. `secret_arns_describe_only` — secrets where terraform only
  #    creates the container (`aws_secretsmanager_secret`) and the
  #    operator / app writes the value out-of-band. Plan only needs
  #    DescribeSecret; deploy must NOT have GetSecretValue here. Was
  #    previously bundled into a wildcard grant on `dante/<env>/*`
  #    which let CI read Personio + awork tokens + AUTH_SECRET — none
  #    of which CI ever writes (T2.2 split).
  dynamic "statement" {
    for_each = length(var.secret_arns_read_write) == 0 ? [] : [1]
    content {
      effect = "Allow"
      actions = [
        "secretsmanager:GetSecretValue",
        "secretsmanager:PutSecretValue",
        "secretsmanager:DescribeSecret",
        "secretsmanager:UpdateSecret",
        "secretsmanager:UpdateSecretVersionStage",
        "secretsmanager:TagResource",
        "secretsmanager:UntagResource",
      ]
      resources = var.secret_arns_read_write
    }
  }
  dynamic "statement" {
    for_each = length(var.secret_arns_describe_only) == 0 ? [] : [1]
    content {
      effect = "Allow"
      actions = [
        "secretsmanager:DescribeSecret",
        "secretsmanager:TagResource",
        "secretsmanager:UntagResource",
      ]
      resources = var.secret_arns_describe_only
    }
  }

  # Terraform remote state (only if we've migrated off local backend).
  dynamic "statement" {
    for_each = var.terraform_state_bucket_arn == null ? [] : [1]
    content {
      effect    = "Allow"
      actions   = ["s3:ListBucket", "s3:GetObject", "s3:PutObject"]
      resources = [var.terraform_state_bucket_arn, "${var.terraform_state_bucket_arn}/*"]
    }
  }

  dynamic "statement" {
    for_each = var.terraform_state_lock_table_arn == null ? [] : [1]
    content {
      effect = "Allow"
      actions = [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:DeleteItem",
      ]
      resources = [var.terraform_state_lock_table_arn]
    }
  }
}

resource "aws_iam_role_policy" "deploy" {
  name   = "${local.name}-deploy"
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy.json
}

# Attach the AWS-managed `ReadOnlyAccess` so `terraform plan`'s refresh
# pass can call Describe/Get on every resource in the state. Without
# this we'd have to enumerate every service the modules touch (ec2,
# rds, ecs, cognito, alb, route53, acm, waf, kms, sns, sqs, ecr,
# logs, secretsmanager, lambda, iam, sesv2, …) and keep the list in
# sync forever. The write paths above stay narrowly scoped — read
# breadth is the only thing this expands.
resource "aws_iam_role_policy_attachment" "deploy_read_only" {
  role       = aws_iam_role.deploy.id
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}
