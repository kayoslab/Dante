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

  # Secrets Manager — terraform refreshes secret_version resources
  # during plan (needs GetSecretValue) and rewrites them on apply
  # (needs PutSecretValue). AWS's managed ReadOnlyAccess deliberately
  # excludes GetSecretValue, so it has to be granted explicitly.
  # Scoped to `dante/<env>/*` so a compromised CI token can't pull
  # secrets from elsewhere in the account.
  dynamic "statement" {
    for_each = length(var.secret_arn_prefixes) == 0 ? [] : [1]
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
      resources = [for p in var.secret_arn_prefixes : "${p}*"]
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
