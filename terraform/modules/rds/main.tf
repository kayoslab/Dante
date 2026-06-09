/**
 * RDS PostgreSQL module.
 *
 * Posture for prod day-1:
 *   - Single-AZ t4g.micro (€15–18/mo). Flip multi_az on later.
 *   - Storage encrypted with the AWS-managed `aws/rds` KMS key.
 *   - Master credential rotated into Secrets Manager via the managed
 *     password feature (`manage_master_user_password = true`). The app
 *     reads the secret at boot — no plaintext in tfvars or env vars.
 *   - 7-day automated backups, deletion protection on.
 *   - Parameter group: log slow queries (>1s) + DDL for audit.
 *
 * What this module does NOT do:
 *   - Cross-region read replicas (defer until DR matters)
 *   - RDS Proxy (worthwhile at 100+ concurrent connections; we're at <10)
 *   - IAM database authentication (cleaner than passwords but the
 *     managed password rotation gets us most of the benefit)
 */

locals {
  identifier = "${var.name_prefix}-${var.environment}"
}

# --- Subnet group + parameter group ----------------------------------------

resource "aws_db_subnet_group" "this" {
  name        = "${local.identifier}-subnets"
  description = "Data-tier private subnets for ${local.identifier}."
  subnet_ids  = var.data_subnet_ids

  tags = {
    Name = "${local.identifier}-subnets"
  }
}

resource "aws_db_parameter_group" "this" {
  name        = "${local.identifier}-pg"
  family      = "postgres${split(".", var.engine_version)[0]}"
  description = "Custom params for ${local.identifier}: log slow queries + DDL."

  parameter {
    name  = "log_statement"
    value = "ddl" # CREATE/ALTER/DROP only — DML is too noisy
  }

  parameter {
    name  = "log_min_duration_statement"
    value = "1000" # log statements taking >1s; tune down if you need finer
  }

  parameter {
    name  = "log_connections"
    value = "1"
  }

  parameter {
    name  = "log_disconnections"
    value = "1"
  }
}

# --- Security group --------------------------------------------------------

resource "aws_security_group" "rds" {
  name        = "${local.identifier}-rds"
  description = "RDS Postgres for ${local.identifier}. Ingress 5432 from approved app SGs only."
  vpc_id      = var.vpc_id

  egress {
    description = "RDS does not initiate outbound, but the default allow-all egress keeps maintenance traffic (extensions, monitoring) from being blocked."
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${local.identifier}-rds"
  }
}

# Ingress rules — one per allowed source SG. Loop avoids hard-coding the
# count and lets the caller pass an empty list during initial bring-up.
resource "aws_vpc_security_group_ingress_rule" "from_app" {
  for_each                     = toset(var.allowed_ingress_security_group_ids)
  security_group_id            = aws_security_group.rds.id
  referenced_security_group_id = each.value
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "Postgres from SG ${each.value}"
}

# --- DB instance -----------------------------------------------------------

resource "aws_db_instance" "this" {
  identifier = local.identifier

  engine                = "postgres"
  engine_version        = var.engine_version
  instance_class        = var.instance_class
  allocated_storage     = var.allocated_storage_gb
  max_allocated_storage = var.max_allocated_storage_gb
  storage_type          = "gp3"
  storage_encrypted     = true # No KMS key id → uses the AWS-managed `aws/rds` key

  db_name  = var.database_name
  username = var.master_username
  # No `password` set — RDS manages it via Secrets Manager.
  manage_master_user_password = true

  vpc_security_group_ids = [aws_security_group.rds.id]
  db_subnet_group_name   = aws_db_subnet_group.this.name
  parameter_group_name   = aws_db_parameter_group.this.name
  publicly_accessible    = false # explicit — RDS is in data subnets with no internet route

  multi_az          = var.multi_az
  availability_zone = var.multi_az ? null : null # let RDS pick when single-AZ; leave null either way

  backup_retention_period = var.backup_retention_days
  backup_window           = var.backup_window
  maintenance_window      = var.maintenance_window
  copy_tags_to_snapshot   = true

  performance_insights_enabled          = var.performance_insights_enabled
  performance_insights_retention_period = var.performance_insights_enabled ? 7 : null
  monitoring_interval                   = var.monitoring_interval_seconds
  enabled_cloudwatch_logs_exports       = ["postgresql"] # ships pg log_* output to CloudWatch

  deletion_protection       = var.deletion_protection
  skip_final_snapshot       = var.skip_final_snapshot
  final_snapshot_identifier = var.skip_final_snapshot ? null : "${local.identifier}-final-${formatdate("YYYY-MM-DD-hhmm", timestamp())}"

  apply_immediately = false # Defer destructive changes to the maintenance window

  # Don't churn on the timestamp inside final_snapshot_identifier on every
  # plan — only matters when destroy is triggered.
  lifecycle {
    ignore_changes = [final_snapshot_identifier]
  }

  tags = {
    Name = local.identifier
  }
}

# --- CloudWatch log group --------------------------------------------------
#
# RDS creates `/aws/rds/instance/<identifier>/postgresql` on first log
# export. Setting retention here pins it to a sensible window — without
# this resource, the default is "never expire" and storage costs creep.

resource "aws_cloudwatch_log_group" "postgresql" {
  name              = "/aws/rds/instance/${local.identifier}/postgresql"
  retention_in_days = 30
}
