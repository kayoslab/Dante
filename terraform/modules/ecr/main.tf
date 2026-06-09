/**
 * ECR repository for the app container.
 *
 * Posture:
 *   - IMMUTABLE tags in prod — every release tags with the git SHA so a
 *     rollback is `aws ecs update-service --task-definition <prev>`.
 *   - Scan on push (free).
 *   - Encryption with the AWS-managed KMS key (customer-managed key
 *     adds operational burden for zero added security at this scale).
 *   - Lifecycle policy expires both tagged-but-old and untagged images.
 *
 * The CI pipeline gets push rights via an IAM role / OIDC trust — that
 * lives outside this module since it's pipeline-shape-specific.
 */

locals {
  name = "${var.name_prefix}-${var.environment}-app"
}

resource "aws_ecr_repository" "this" {
  name                 = local.name
  image_tag_mutability = var.image_tag_mutability

  image_scanning_configuration {
    scan_on_push = var.scan_on_push
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = {
    Name = local.name
  }
}

resource "aws_ecr_lifecycle_policy" "this" {
  repository = aws_ecr_repository.this.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep last ${var.max_image_count} tagged images"
        selection = {
          tagStatus      = "tagged"
          tagPatternList = ["*"]
          countType      = "imageCountMoreThan"
          countNumber    = var.max_image_count
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Expire untagged images after ${var.untagged_image_expiry_days} days"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = var.untagged_image_expiry_days
        }
        action = { type = "expire" }
      },
    ]
  })
}
