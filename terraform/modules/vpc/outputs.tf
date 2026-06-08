output "vpc_id" {
  description = "VPC ID. Pass into the RDS, ECS, and ALB modules."
  value       = aws_vpc.this.id
}

output "cidr_block" {
  description = "VPC CIDR. Useful for security group rules that need to scope by VPC range."
  value       = aws_vpc.this.cidr_block
}

output "public_subnet_ids" {
  description = "Public subnet IDs, ordered by AZ. Used by the ALB."
  value       = aws_subnet.public[*].id
}

output "app_subnet_ids" {
  description = "App-tier private subnet IDs. Used by ECS Fargate tasks + sync Lambda ENIs."
  value       = aws_subnet.app[*].id
}

output "data_subnet_ids" {
  description = "Data-tier private subnet IDs. Used by RDS. No internet route attached."
  value       = aws_subnet.data[*].id
}

output "availability_zones" {
  description = "AZ names the subnets are spread across. Useful for RDS Multi-AZ assertions."
  value       = local.azs
}

output "nat_gateway_ids" {
  description = "NAT gateway IDs. One when single_nat_gateway=true, else one per AZ."
  value       = aws_nat_gateway.this[*].id
}

output "vpc_endpoints_security_group_id" {
  description = "Security group ID attached to the VPC interface endpoints. Allows HTTPS from inside the VPC."
  value       = aws_security_group.endpoints.id
}
