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
  description = "When true, provision ONE NAT in the first AZ that ALL private subnets route through. Saves ~€32/month vs one-per-AZ but creates a SPOF (AZ outage = no outbound for the other AZs). For a 40-person internal tool the cost win is worth the risk."
  type        = bool
  default     = true
}

variable "nat_mode" {
  description = "`gateway` provisions managed AWS NAT Gateway(s) (~€32/mo each, fully managed, HA within an AZ). `instance` provisions an EC2 instance running iptables MASQUERADE (~€3/mo on t4g.nano). For a 40-user internal tool the NAT instance is the right cost trade on a paid account. AWS Free Plan accounts only permit Free Tier eligible instance types, which excludes the ARM Graviton family used here — keep `gateway` there."
  type        = string
  default     = "gateway"
  validation {
    condition     = contains(["gateway", "instance"], var.nat_mode)
    error_message = "nat_mode must be either 'gateway' or 'instance'."
  }
}

variable "nat_instance_type" {
  description = "EC2 instance type for the NAT instance when `nat_mode = instance`. t4g.nano (ARM64, 2 vCPU burst, 0.5 GB RAM) handles ~5 Gbps NAT for negligible cost; t4g.micro for higher throughput environments. Personio + awork sync at our scale is well within t4g.nano's headroom."
  type        = string
  default     = "t4g.nano"
}

variable "enable_flow_logs" {
  description = "When true, send VPC Flow Logs to CloudWatch. Costs ~€0.50/GB ingested + ~€0.03/GB stored. For a low-traffic HR tool, leave off until an incident motivates it."
  type        = bool
  default     = false
}

variable "interface_endpoint_services" {
  description = "AWS service names to expose via VPC interface endpoints (~€9.50/mo per AZ — so ~€19/mo each in a 2-AZ deployment). These keep the app/Lambda → AWS-API traffic on AWS's private backbone instead of crossing the NAT. The defaults cover only the services where call volume / data sensitivity justifies the cost. Lower-volume control-plane services (sts, logs) are deliberately left to NAT — the TLS-over-NAT-IP path is equally secure and the data charges are negligible at our scale."
  type        = list(string)
  default = [
    "secretsmanager",
    "kms",
  ]
}

variable "endpoint_policies" {
  description = "Per-service VPC endpoint policy JSON. Default empty map: AWS's auto-attached \"full access\" policy applies — anyone in the VPC who has IAM permission can hit the endpoint (was M-002 in the pre-launch pen test: an RCE'd workload could call any Secrets Manager API). Tight envs should pass a per-service policy here that pins the Principal to specific role ARNs."
  type        = map(string)
  default     = {}
}
