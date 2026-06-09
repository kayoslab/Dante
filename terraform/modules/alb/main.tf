/**
 * Application Load Balancer for the Next.js app.
 *
 * Layout:
 *   - HTTPS listener on 443 — TLS termination with the passed-in ACM cert.
 *   - HTTP listener on 80 — permanent redirect to 443.
 *   - Single target group → ECS service tasks on `container_port`.
 *
 * Health check on `/api/auth/csrf` because:
 *   - Always 200 (no auth required, returns a CSRF token)
 *   - Doesn't touch the DB → ALB health check doesn't false-positive
 *     during DB blips
 *   - Lightweight → low overhead at 30s intervals across 2+ tasks
 *
 * Security group: open ingress on 80/443 by default. Tighten via
 * `var.ingress_cidr_blocks` if WAFv2 fronts the ALB or if traffic is
 * scoped to office IPs.
 */

locals {
  name = "${var.name_prefix}-${var.environment}-alb"
}

# --- Security groups -------------------------------------------------------

resource "aws_security_group" "alb" {
  name        = local.name
  description = "${local.name} ingress on 80/443."
  vpc_id      = var.vpc_id

  egress {
    description = "ALB to targets (any port, intra-VPC). Refined by the target-side SG."
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = local.name
  }
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  for_each          = toset(var.ingress_cidr_blocks)
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = each.value
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "HTTPS from ${each.value}"
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  for_each          = toset(var.ingress_cidr_blocks)
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = each.value
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  description       = "HTTP from ${each.value} (redirected to HTTPS at the listener)"
}

# Target-side SG — the ECS service attaches this. ALB → target on
# container_port only.
resource "aws_security_group" "targets" {
  name        = "${local.name}-targets"
  description = "Allow inbound from ${local.name} on the container port."
  vpc_id      = var.vpc_id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${local.name}-targets"
  }
}

resource "aws_vpc_security_group_ingress_rule" "targets_from_alb" {
  security_group_id            = aws_security_group.targets.id
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = var.container_port
  to_port                      = var.container_port
  description                  = "ALB to app container"
}

# --- ALB -------------------------------------------------------------------

resource "aws_lb" "this" {
  name               = local.name
  internal           = false
  load_balancer_type = "application"
  subnets            = var.public_subnet_ids
  security_groups    = [aws_security_group.alb.id]

  idle_timeout               = var.idle_timeout_seconds
  enable_deletion_protection = var.deletion_protection
  drop_invalid_header_fields = true # Reject smuggled headers — best-practice against request-smuggling

  dynamic "access_logs" {
    for_each = var.access_logs_bucket == null ? [] : [1]
    content {
      bucket  = var.access_logs_bucket
      prefix  = var.access_logs_prefix
      enabled = true
    }
  }

  tags = {
    Name = local.name
  }
}

# --- Target group ----------------------------------------------------------

resource "aws_lb_target_group" "app" {
  name        = "${local.name}-tg"
  port        = var.container_port
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip" # Fargate task ENIs

  health_check {
    enabled             = true
    path                = var.health_check_path
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 30
    timeout             = 5
    matcher             = "200"
  }

  # Deregistration delay: how long the ALB waits for in-flight requests
  # before pulling a task. 30s covers typical Next.js page renders.
  deregistration_delay = 30

  tags = {
    Name = "${local.name}-tg"
  }
}

# --- Listeners -------------------------------------------------------------

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06" # TLS 1.2 + 1.3, modern ciphers
  certificate_arn   = var.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}
