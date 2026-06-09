variable "environment" {
  description = "Environment slug — used in resource names + tags."
  type        = string
}

variable "name_prefix" {
  description = "Prefix for resource names."
  type        = string
  default     = "dante"
}

variable "cidr_block" {
  description = "VPC CIDR. /16 by default leaves plenty of room for /24 subnets and future expansion. Pick something that doesn't collide with on-prem ranges if you ever set up Site-to-Site VPN."
  type        = string
  default     = "10.0.0.0/16"

  validation {
    condition     = can(cidrnetmask(var.cidr_block))
    error_message = "cidr_block must be a valid CIDR."
  }
}

variable "az_count" {
  description = "Number of Availability Zones to spread subnets across. 2 is the minimum for RDS Multi-AZ readiness; 3 adds capacity headroom at the cost of more subnets to track."
  type        = number
  default     = 2

  validation {
    condition     = var.az_count >= 2 && var.az_count <= 3
    error_message = "az_count must be 2 or 3."
  }
}

variable "single_nat_gateway" {
  description = "When true, provision ONE NAT gateway in the first AZ that ALL private subnets route through. Saves ~€32/month vs one-per-AZ but creates a SPOF (AZ outage = no outbound for the other AZs). For a 40-person internal tool the cost win is worth the risk."
  type        = bool
  default     = true
}

variable "enable_flow_logs" {
  description = "When true, send VPC Flow Logs to CloudWatch. Costs ~€0.50/GB ingested + ~€0.03/GB stored. For a low-traffic HR tool, leave off until an incident motivates it."
  type        = bool
  default     = false
}

variable "interface_endpoint_services" {
  description = "AWS service names to expose via VPC interface endpoints (~€7/mo each). These let the app/Lambda reach AWS APIs without crossing the NAT, which dominates monthly cost. The defaults cover what the sync Lambda actually uses."
  type        = list(string)
  default = [
    "secretsmanager",
    "kms",
    "logs",
    "sts",
  ]
}

variable "endpoint_policies" {
  description = "Per-service VPC endpoint policy JSON. Default empty map: AWS's auto-attached \"full access\" policy applies — anyone in the VPC who has IAM permission can hit the endpoint (was M-002 in the pre-launch pen test: an RCE'd workload could call any Secrets Manager API). Tight envs should pass a per-service policy here that pins the Principal to specific role ARNs."
  type        = map(string)
  default     = {}
}
