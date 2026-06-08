/**
 * DNS + ACM module.
 *
 * Bundles:
 *   - ACM certificate (DNS validation)
 *   - Validation records in Route 53
 *   - A-alias record pointing the app domain at the ALB
 *
 * Assumes the parent zone (e.g. `example.com`) is already in Route 53.
 * If it isn't, register the domain or create the zone first, then point
 * your registrar's NS records at it.
 *
 * The cert is in the same region as the ALB (Frankfurt). If you later
 * add CloudFront, that requires a separate cert in us-east-1 — handle
 * that out-of-band, not in this module.
 */

resource "aws_acm_certificate" "this" {
  domain_name               = var.domain_name
  subject_alternative_names = var.subject_alternative_names
  validation_method         = "DNS"

  # Replace, not delete-then-create — the old cert keeps serving until
  # the new one validates. Saves ~15 min of downtime on cert rotation.
  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Name = var.domain_name
  }
}

# One Route 53 validation record per name in the cert. ACM emits a
# distinct CNAME challenge for each SAN; we materialize them all here.
resource "aws_route53_record" "validation" {
  for_each = {
    for dvo in aws_acm_certificate.this.domain_validation_options :
    dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  zone_id = var.hosted_zone_id
  name    = each.value.name
  type    = each.value.type
  records = [each.value.record]
  ttl     = 60

  # ACM cert reuse / re-issuance can change the validation record value
  # — let the new record win without an explicit destroy.
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "this" {
  certificate_arn         = aws_acm_certificate.this.arn
  validation_record_fqdns = [for r in aws_route53_record.validation : r.fqdn]
}

# A-alias record → ALB. Use an alias (not a CNAME) so requests stay on
# the AWS backbone without an extra DNS hop.
resource "aws_route53_record" "app" {
  zone_id = var.hosted_zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = var.alb_dns_name
    zone_id                = var.alb_zone_id
    evaluate_target_health = true
  }
}
