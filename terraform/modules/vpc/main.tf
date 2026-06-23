/**
 * VPC module — networking foundation for the Dante stack.
 *
 * Layout per AZ:
 *   public subnet  (/24) — ALB ENIs only
 *   app subnet     (/24) — ECS Fargate tasks, sync Lambda ENIs
 *   data subnet    (/24) — RDS only; no internet route, no public IPs
 *
 * The three-tier split is deliberate: data subnets have no NAT route,
 * so a compromised app container cannot exfiltrate from RDS over the
 * internet without first compromising an outbound path. Within-VPC
 * traffic between app → data still works via security group rules.
 *
 * Why single NAT by default: at 40 users the AZ-outage risk is lower
 * than the €32/mo redundancy cost. Flip `single_nat_gateway = false`
 * for production-critical multi-AZ.
 *
 * VPC endpoints (Secrets Manager + KMS + Logs + STS) are interface
 * endpoints — each costs ~€7/mo but eliminates the NAT charge for
 * AWS API traffic, which is the sync Lambda's biggest outbound
 * pattern. S3 is a gateway endpoint (free).
 */

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  azs  = slice(data.aws_availability_zones.available.names, 0, var.az_count)
  name = "${var.name_prefix}-${var.environment}"

  # /16 → /24 subnets. Layout: public 0..N, app 10..10+N, data 20..20+N
  # leaves the rest of the address space free for future tiers.
  public_subnet_cidrs = [for i in range(var.az_count) : cidrsubnet(var.cidr_block, 8, i)]
  app_subnet_cidrs    = [for i in range(var.az_count) : cidrsubnet(var.cidr_block, 8, 10 + i)]
  data_subnet_cidrs   = [for i in range(var.az_count) : cidrsubnet(var.cidr_block, 8, 20 + i)]
}

# --- VPC + IGW --------------------------------------------------------------

resource "aws_vpc" "this" {
  cidr_block           = var.cidr_block
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name = local.name
  }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id

  tags = {
    Name = "${local.name}-igw"
  }
}

# --- Subnets ----------------------------------------------------------------

resource "aws_subnet" "public" {
  count                   = var.az_count
  vpc_id                  = aws_vpc.this.id
  cidr_block              = local.public_subnet_cidrs[count.index]
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = false # ALB gets an EIP-equivalent via the service itself; tasks shouldn't have public IPs

  tags = {
    Name = "${local.name}-public-${local.azs[count.index]}"
    Tier = "public"
  }
}

resource "aws_subnet" "app" {
  count             = var.az_count
  vpc_id            = aws_vpc.this.id
  cidr_block        = local.app_subnet_cidrs[count.index]
  availability_zone = local.azs[count.index]

  tags = {
    Name = "${local.name}-app-${local.azs[count.index]}"
    Tier = "app"
  }
}

resource "aws_subnet" "data" {
  count             = var.az_count
  vpc_id            = aws_vpc.this.id
  cidr_block        = local.data_subnet_cidrs[count.index]
  availability_zone = local.azs[count.index]

  tags = {
    Name = "${local.name}-data-${local.azs[count.index]}"
    Tier = "data"
  }
}

# --- NAT (gateway OR instance) ----------------------------------------------

locals {
  nat_count        = var.single_nat_gateway ? 1 : var.az_count
  use_nat_gateway  = var.nat_mode == "gateway"
  use_nat_instance = var.nat_mode == "instance"
}

# Elastic IPs are shared between both NAT modes — the AWS NAT Gateway
# attaches one directly; the NAT instance uses one via the network
# interface below. Static IP matters because Personio + awork allowlist
# our outbound source IP.
resource "aws_eip" "nat" {
  count  = local.nat_count
  domain = "vpc"

  tags = {
    Name = "${local.name}-nat-${count.index}"
  }
}

# Managed NAT Gateway (mode = "gateway"). Fully managed, ~€32/mo each,
# scales transparently. Pick this when the operations cost of a NAT
# instance starts to outweigh the savings.
resource "aws_nat_gateway" "this" {
  count         = local.use_nat_gateway ? local.nat_count : 0
  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id

  depends_on = [aws_internet_gateway.this]

  tags = {
    Name = "${local.name}-nat-${count.index}"
  }
}

# NAT instance (mode = "instance"). ~€3/mo each on t4g.nano. One job:
# forward packets from private subnets to the internet via iptables
# MASQUERADE on the public interface.
#
# Self-healing: this is a single EC2 instance, not an ASG. If it dies,
# the next `terraform apply` recreates it; ~5 minutes of NAT downtime
# during which the daily sync would fail (rolled over to the next day's
# run) and AWS-API calls that DON'T go via VPC endpoints (we keep
# Secrets Manager + KMS on endpoints) would fail. Acceptable for a
# 40-user internal tool. Upgrade to an ASG-backed setup if that ever
# stops being true.
data "aws_ami" "nat_instance" {
  count       = local.use_nat_instance ? 1 : 0
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-2023*-arm64"]
  }

  filter {
    name   = "architecture"
    values = ["arm64"]
  }
}

resource "aws_security_group" "nat_instance" {
  count       = local.use_nat_instance ? 1 : 0
  name        = "${local.name}-nat-instance"
  description = "NAT instance: forwards from VPC CIDR to internet."
  vpc_id      = aws_vpc.this.id

  ingress {
    description = "All TCP from VPC (private subnets need NAT for outbound)."
    from_port   = 0
    to_port     = 65535
    protocol    = "tcp"
    cidr_blocks = [aws_vpc.this.cidr_block]
  }

  ingress {
    description = "All UDP from VPC (DNS, NTP, etc.)."
    from_port   = 0
    to_port     = 65535
    protocol    = "udp"
    cidr_blocks = [aws_vpc.this.cidr_block]
  }

  ingress {
    description = "ICMP from VPC (traceroute / MTU discovery)."
    from_port   = -1
    to_port     = -1
    protocol    = "icmp"
    cidr_blocks = [aws_vpc.this.cidr_block]
  }

  egress {
    description = "All egress to the internet (this is the whole point)."
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${local.name}-nat-instance"
  }
}

resource "aws_network_interface" "nat_instance" {
  count             = local.use_nat_instance ? local.nat_count : 0
  subnet_id         = aws_subnet.public[count.index].id
  security_groups   = [aws_security_group.nat_instance[0].id]
  source_dest_check = false # NAT MUST forward packets it didn't originate.

  tags = {
    Name = "${local.name}-nat-eni-${count.index}"
  }
}

resource "aws_eip_association" "nat_instance" {
  count                = local.use_nat_instance ? local.nat_count : 0
  network_interface_id = aws_network_interface.nat_instance[count.index].id
  allocation_id        = aws_eip.nat[count.index].id
}

resource "aws_instance" "nat" {
  count         = local.use_nat_instance ? local.nat_count : 0
  ami           = data.aws_ami.nat_instance[0].id
  instance_type = var.nat_instance_type

  network_interface {
    network_interface_id = aws_network_interface.nat_instance[count.index].id
    device_index         = 0
  }

  # Enable IPv4 forwarding + MASQUERADE so packets from the private
  # subnets get their source rewritten to this instance's public IP on
  # the way out. Survives reboots via /etc/sysctl.d and the iptables
  # service. AL2023 has nftables; we use the iptables-nft compat layer.
  user_data = <<-EOT
    #!/bin/bash
    set -euo pipefail
    dnf install -y iptables-services
    sysctl -w net.ipv4.ip_forward=1
    echo "net.ipv4.ip_forward=1" > /etc/sysctl.d/99-nat.conf
    iptables -t nat -A POSTROUTING -o $(ip route get 1.1.1.1 | awk '{print $5; exit}') -j MASQUERADE
    iptables-save > /etc/sysconfig/iptables
    systemctl enable --now iptables
  EOT

  # AL2023 sets imdsv2-required by default already, but pin explicitly
  # so we don't drift on a future AMI rev.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  # Encrypt the root volume — there's nothing sensitive on a NAT
  # instance, but defaults matter when someone else copies this module.
  root_block_device {
    encrypted   = true
    volume_size = 8
    volume_type = "gp3"
  }

  tags = {
    Name = "${local.name}-nat-${count.index}"
  }
}

# --- Route tables -----------------------------------------------------------

# Single public route table — all public subnets share the same IGW route.
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }

  tags = {
    Name = "${local.name}-public-rt"
  }
}

resource "aws_route_table_association" "public" {
  count          = var.az_count
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# One private route table per AZ. With single_nat_gateway = true, they all
# point at the same NAT in AZ-a; with one-per-AZ, each AZ stays local.
# The default-route target is either the NAT Gateway or the NAT
# instance's primary ENI, depending on `var.nat_mode`.
resource "aws_route_table" "app" {
  count  = var.az_count
  vpc_id = aws_vpc.this.id

  route {
    cidr_block = "0.0.0.0/0"
    nat_gateway_id = local.use_nat_gateway ? (
      aws_nat_gateway.this[var.single_nat_gateway ? 0 : count.index].id
    ) : null
    network_interface_id = local.use_nat_instance ? (
      aws_network_interface.nat_instance[var.single_nat_gateway ? 0 : count.index].id
    ) : null
  }

  tags = {
    Name = "${local.name}-app-rt-${local.azs[count.index]}"
  }
}

resource "aws_route_table_association" "app" {
  count          = var.az_count
  subnet_id      = aws_subnet.app[count.index].id
  route_table_id = aws_route_table.app[count.index].id
}

# Data subnets get NO internet route. RDS shouldn't reach out.
# Same-VPC traffic doesn't need a route — VPC local route is implicit.
resource "aws_route_table" "data" {
  count  = var.az_count
  vpc_id = aws_vpc.this.id

  tags = {
    Name = "${local.name}-data-rt-${local.azs[count.index]}"
  }
}

resource "aws_route_table_association" "data" {
  count          = var.az_count
  subnet_id      = aws_subnet.data[count.index].id
  route_table_id = aws_route_table.data[count.index].id
}

# --- VPC endpoints ----------------------------------------------------------
#
# Interface endpoints (one ENI per AZ) let the app/Lambda reach AWS APIs
# without traversing NAT. At ~€7/mo each they pay for themselves quickly:
# the sync Lambda hits Secrets Manager and KMS on every invocation, and
# CloudWatch Logs on every log line. S3 is a free gateway endpoint.

# Default SG allowing HTTPS from inside the VPC to the endpoints.
resource "aws_security_group" "endpoints" {
  name        = "${local.name}-vpc-endpoints"
  description = "Allow HTTPS from inside the VPC to interface VPC endpoints."
  vpc_id      = aws_vpc.this.id

  ingress {
    description = "HTTPS from within the VPC"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = [var.cidr_block]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${local.name}-vpc-endpoints"
  }
}

data "aws_region" "current" {}

resource "aws_vpc_endpoint" "interface" {
  for_each          = toset(var.interface_endpoint_services)
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${data.aws_region.current.name}.${each.value}"
  vpc_endpoint_type = "Interface"
  # Interface endpoints require AT MOST one subnet per AZ. Use the app
  # subnets (one per AZ) — the ECS app, sync Lambda, and any RDS-side
  # tooling all route through them via the endpoint's private DNS.
  subnet_ids          = aws_subnet.app[*].id
  security_group_ids  = [aws_security_group.endpoints.id]
  private_dns_enabled = true

  # Endpoint policy gates the API calls allowed through this endpoint
  # regardless of the caller's IAM. Defaulting to null (AWS's auto-
  # attached full-access policy) preserves today's behavior. Tight envs
  # pass a JSON policy here pinning the Principal to specific role ARNs.
  policy = try(var.endpoint_policies[each.value], null)

  tags = {
    Name = "${local.name}-vpce-${each.value}"
  }
}

# S3 gateway endpoint — free. Even if the app doesn't use S3 directly,
# the ECR pull path hits S3 (image layers), and CloudWatch Logs uses S3
# under the hood for some operations.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${data.aws_region.current.name}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = concat(aws_route_table.app[*].id, aws_route_table.data[*].id)

  tags = {
    Name = "${local.name}-vpce-s3"
  }
}

# --- Flow Logs (optional) ---------------------------------------------------

resource "aws_cloudwatch_log_group" "flow_logs" {
  count             = var.enable_flow_logs ? 1 : 0
  name              = "/aws/vpc/${local.name}/flow-logs"
  retention_in_days = 30
}

resource "aws_iam_role" "flow_logs" {
  count = var.enable_flow_logs ? 1 : 0
  name  = "${local.name}-flow-logs"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "vpc-flow-logs.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "flow_logs" {
  count = var.enable_flow_logs ? 1 : 0
  name  = "${local.name}-flow-logs"
  role  = aws_iam_role.flow_logs[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "logs:CreateLogStream",
        "logs:PutLogEvents",
        "logs:DescribeLogGroups",
        "logs:DescribeLogStreams",
      ]
      Resource = "*"
    }]
  })
}

resource "aws_flow_log" "this" {
  count                    = var.enable_flow_logs ? 1 : 0
  iam_role_arn             = aws_iam_role.flow_logs[0].arn
  log_destination          = aws_cloudwatch_log_group.flow_logs[0].arn
  traffic_type             = "REJECT" # Only rejects — accept logs at scale add noise without value here
  vpc_id                   = aws_vpc.this.id
  max_aggregation_interval = 60
}
