variable "environment" {
  description = "Environment slug — used in resource names + tags."
  type        = string
}

variable "name_prefix" {
  description = "Prefix for resource names."
  type        = string
  default     = "dante"
}

# --- network -----------------------------------------------------------------

variable "vpc_id" {
  description = "VPC the RDS instance lives in. Pass from the VPC module's output."
  type        = string
}

variable "data_subnet_ids" {
  description = "Private data-tier subnet IDs (no internet route). Must be in at least 2 AZs to satisfy the DB subnet group's Multi-AZ readiness requirement, even if Multi-AZ itself is off."
  type        = list(string)

  validation {
    condition     = length(var.data_subnet_ids) >= 2
    error_message = "data_subnet_ids must contain at least 2 entries (different AZs) for the DB subnet group."
  }
}

variable "allowed_ingress_security_group_ids" {
  description = "Security groups allowed to reach the DB on its port. Pass the app's SG (ECS tasks) and the sync Lambda's SG. Empty list creates the SG with no ingress — useful for initial bring-up before app SGs exist."
  type        = list(string)
  default     = []
}

# --- engine ------------------------------------------------------------------

variable "engine_version" {
  description = "Postgres major version. Pin to a maintained version. Patch versions are auto-applied via the maintenance window."
  type        = string
  default     = "16.4"
}

variable "instance_class" {
  description = "RDS instance class. t4g.micro covers a 40-user load comfortably (2 vCPU, 1 GB RAM). Bump to t4g.small if connection pool pressure or analytic queries push the buffer cache."
  type        = string
  default     = "db.t4g.micro"
}

variable "allocated_storage_gb" {
  description = "Initial GP3 storage in GB. Storage Autoscaling kicks in up to `max_allocated_storage_gb`."
  type        = number
  default     = 20

  validation {
    condition     = var.allocated_storage_gb >= 20
    error_message = "RDS GP3 has a 20 GB minimum."
  }
}

variable "max_allocated_storage_gb" {
  description = "Storage Autoscaling cap. RDS grows the volume in-place when free space drops below the threshold."
  type        = number
  default     = 100
}

# --- HA + backups ------------------------------------------------------------

variable "multi_az" {
  description = "Enable Multi-AZ. Doubles the cost and replicates synchronously to a standby. Off by default for prod-day-1; flip on once traffic / SLA justifies it."
  type        = bool
  default     = false
}

variable "backup_retention_days" {
  description = "Automated backup retention in days. 1–35 enables automated backups (7 covers the typical incident-response window without growing storage costs much). 0 disables automated backups entirely — only acceptable for throwaway environments; never production."
  type        = number
  default     = 7

  validation {
    condition     = var.backup_retention_days >= 0 && var.backup_retention_days <= 35
    error_message = "backup_retention_days must be between 0 (disabled) and 35."
  }
}

variable "backup_window" {
  description = "Daily backup window in UTC (HH:MM-HH:MM). Use a low-traffic window before the sync Lambda's 06:00 UTC cron."
  type        = string
  default     = "03:00-04:00"
}

variable "maintenance_window" {
  description = "Weekly maintenance window in UTC (ddd:HH:MM-ddd:HH:MM). Off-hours; aligned with backups."
  type        = string
  default     = "sun:04:00-sun:05:00"
}

# --- protection --------------------------------------------------------------

variable "deletion_protection" {
  description = "Block `terraform destroy` from removing the database. Should be true in any env that holds real data."
  type        = bool
  default     = true
}

variable "skip_final_snapshot" {
  description = "Skip the snapshot RDS takes when the instance is destroyed. Always false in prod."
  type        = bool
  default     = false
}

# --- observability -----------------------------------------------------------

variable "performance_insights_enabled" {
  description = "Performance Insights captures wait events + top SQL. Free for 7 days of retention."
  type        = bool
  default     = true
}

variable "monitoring_interval_seconds" {
  description = "Enhanced Monitoring sample interval. 0 disables it; 60 gives per-minute OS metrics (~€0.50/month). Use 0 unless you're chasing a perf issue."
  type        = number
  default     = 0

  validation {
    condition     = contains([0, 1, 5, 10, 15, 30, 60], var.monitoring_interval_seconds)
    error_message = "monitoring_interval_seconds must be one of 0, 1, 5, 10, 15, 30, 60."
  }
}

# --- DB shape ----------------------------------------------------------------

variable "database_name" {
  description = "Initial database created on the instance. The app reads this from the master_user_secret."
  type        = string
  default     = "dante"
}

variable "master_username" {
  description = "Bootstrap superuser. We never use this in the app — `aws_db_instance.manage_master_user_password = true` rotates it into Secrets Manager. The app reads from the managed secret."
  type        = string
  default     = "dante_admin"
}
