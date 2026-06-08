/**
 * WAFv2 Web ACL for the public ALB.
 *
 * Rules (priority order — lower number = evaluated first):
 *    1. ip_reputation       — cut bots/scanners early
 *    2. anonymous_ip        — optional Tor/VPN block
 *    3. geo_allow_list      — optional country gate
 *    4. auth_rate_limit     — /api/auth/* brute-force cap
 *    5. global_rate_limit   — site-wide scraper cap
 *    6. common              — OWASP top-10
 *    7. known_bad_inputs    — CVE signatures
 *    8. sqli                — SQL injection patterns
 *
 * Default action: ALLOW. Block decisions are explicit per-rule.
 *
 * Scope: REGIONAL — Web ACLs that protect an ALB must be regional and
 * provisioned in the same region as the ALB. CloudFront protection
 * needs scope=CLOUDFRONT in us-east-1; not our case.
 */

locals {
  name = "${var.name_prefix}-${var.environment}-waf"
}

resource "aws_wafv2_web_acl" "this" {
  name        = local.name
  description = "Public WAF for ${local.name}."
  scope       = "REGIONAL"

  default_action {
    allow {}
  }

  # --- 1. IP reputation list (managed) ---------------------------------
  dynamic "rule" {
    for_each = var.enable_ip_reputation ? [1] : []
    content {
      name     = "AWS-AWSManagedRulesAmazonIpReputationList"
      priority = 1

      override_action {
        none {}
      }

      statement {
        managed_rule_group_statement {
          name        = "AWSManagedRulesAmazonIpReputationList"
          vendor_name = "AWS"
        }
      }

      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = "ip-reputation"
        sampled_requests_enabled   = true
      }
    }
  }

  # --- 2. Anonymous IP list (Tor / VPN) ---------------------------------
  dynamic "rule" {
    for_each = var.enable_anonymous_ip_block ? [1] : []
    content {
      name     = "AWS-AWSManagedRulesAnonymousIpList"
      priority = 2

      override_action {
        none {}
      }

      statement {
        managed_rule_group_statement {
          name        = "AWSManagedRulesAnonymousIpList"
          vendor_name = "AWS"
        }
      }

      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = "anonymous-ip"
        sampled_requests_enabled   = true
      }
    }
  }

  # --- 3. Geo allow-list ------------------------------------------------
  dynamic "rule" {
    for_each = length(var.geo_allow_list) == 0 ? [] : [1]
    content {
      name     = "GeoAllowList"
      priority = 3

      action {
        block {}
      }

      statement {
        not_statement {
          statement {
            geo_match_statement {
              country_codes = var.geo_allow_list
            }
          }
        }
      }

      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = "geo-allow"
        sampled_requests_enabled   = true
      }
    }
  }

  # --- 4. Auth path rate limit ------------------------------------------
  dynamic "rule" {
    for_each = var.auth_path_rate_limit_per_5min > 0 ? [1] : []
    content {
      name     = "AuthPathRateLimit"
      priority = 4

      action {
        block {}
      }

      statement {
        rate_based_statement {
          limit              = var.auth_path_rate_limit_per_5min
          aggregate_key_type = "IP"

          scope_down_statement {
            byte_match_statement {
              field_to_match {
                uri_path {}
              }
              positional_constraint = "STARTS_WITH"
              search_string         = "/api/auth/"
              text_transformation {
                priority = 0
                type     = "NONE"
              }
            }
          }
        }
      }

      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = "auth-rate"
        sampled_requests_enabled   = true
      }
    }
  }

  # --- 5. Global rate limit ---------------------------------------------
  dynamic "rule" {
    for_each = var.global_rate_limit_per_5min > 0 ? [1] : []
    content {
      name     = "GlobalRateLimit"
      priority = 5

      action {
        block {}
      }

      statement {
        rate_based_statement {
          limit              = var.global_rate_limit_per_5min
          aggregate_key_type = "IP"
        }
      }

      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = "global-rate"
        sampled_requests_enabled   = true
      }
    }
  }

  # --- 6. CommonRuleSet (managed) ---------------------------------------
  dynamic "rule" {
    for_each = var.enable_common_rules ? [1] : []
    content {
      name     = "AWS-AWSManagedRulesCommonRuleSet"
      priority = 6

      override_action {
        # `none` = enforce the rule group's default actions (block).
        # If false positives appear, switch to `count` and tune individual
        # rules via `rule_action_override` inside `managed_rule_group_statement`.
        none {}
      }

      statement {
        managed_rule_group_statement {
          name        = "AWSManagedRulesCommonRuleSet"
          vendor_name = "AWS"

          # SizeRestrictions_BODY ships with an 8KB body cap; Next.js
          # Server Action payloads (esp. with form data) can exceed
          # that, so override to count-only and let the rest enforce.
          rule_action_override {
            name = "SizeRestrictions_BODY"
            action_to_use {
              count {}
            }
          }
        }
      }

      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = "common"
        sampled_requests_enabled   = true
      }
    }
  }

  # --- 7. KnownBadInputs (managed) --------------------------------------
  dynamic "rule" {
    for_each = var.enable_known_bad_inputs ? [1] : []
    content {
      name     = "AWS-AWSManagedRulesKnownBadInputsRuleSet"
      priority = 7

      override_action {
        none {}
      }

      statement {
        managed_rule_group_statement {
          name        = "AWSManagedRulesKnownBadInputsRuleSet"
          vendor_name = "AWS"
        }
      }

      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = "known-bad-inputs"
        sampled_requests_enabled   = true
      }
    }
  }

  # --- 8. SQLi (managed) -------------------------------------------------
  dynamic "rule" {
    for_each = var.enable_sqli_rules ? [1] : []
    content {
      name     = "AWS-AWSManagedRulesSQLiRuleSet"
      priority = 8

      override_action {
        none {}
      }

      statement {
        managed_rule_group_statement {
          name        = "AWSManagedRulesSQLiRuleSet"
          vendor_name = "AWS"
        }
      }

      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = "sqli"
        sampled_requests_enabled   = true
      }
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = local.name
    sampled_requests_enabled   = true
  }

  tags = {
    Name = local.name
  }
}

# --- Association -----------------------------------------------------------

resource "aws_wafv2_web_acl_association" "alb" {
  resource_arn = var.alb_arn
  web_acl_arn  = aws_wafv2_web_acl.this.arn
}

# --- Logging ---------------------------------------------------------------
#
# WAFv2 logging requires a CloudWatch log group whose name starts with
# `aws-waf-logs-`. The group also has to exist before the logging
# configuration can target it.

resource "aws_cloudwatch_log_group" "waf" {
  count             = var.enable_logging ? 1 : 0
  name              = "aws-waf-logs-${local.name}"
  retention_in_days = var.log_retention_days
}

resource "aws_wafv2_web_acl_logging_configuration" "this" {
  count                   = var.enable_logging ? 1 : 0
  resource_arn            = aws_wafv2_web_acl.this.arn
  log_destination_configs = [aws_cloudwatch_log_group.waf[0].arn]

  # Redact the Authorization header so the log group doesn't accumulate
  # bearer tokens / cookies in plaintext.
  redacted_fields {
    single_header {
      name = "authorization"
    }
  }
  redacted_fields {
    single_header {
      name = "cookie"
    }
  }
}

# --- Alarm -----------------------------------------------------------------

resource "aws_sns_topic" "alarms" {
  count = length(var.alarm_email_addresses) == 0 ? 0 : 1
  name  = "${local.name}-alarms"
}

resource "aws_sns_topic_subscription" "alarms_email" {
  for_each  = toset(var.alarm_email_addresses)
  topic_arn = aws_sns_topic.alarms[0].arn
  protocol  = "email"
  endpoint  = each.value
}

data "aws_region" "current" {}

resource "aws_cloudwatch_metric_alarm" "blocked_spike" {
  count               = length(var.alarm_email_addresses) == 0 ? 0 : 1
  alarm_name          = "${local.name}-blocked-spike"
  alarm_description   = "WAF blocked more than ${var.blocked_spike_threshold} requests in 5 minutes. Could be a legitimate burst (release rollout) or an active attack — check the WAF log group ${try(aws_cloudwatch_log_group.waf[0].name, "(logging disabled)")} for source IPs and matched rules."
  namespace           = "AWS/WAFV2"
  metric_name         = "BlockedRequests"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.blocked_spike_threshold
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    WebACL = aws_wafv2_web_acl.this.name
    Region = data.aws_region.current.name
    Rule   = "ALL"
  }

  alarm_actions = [aws_sns_topic.alarms[0].arn]
  ok_actions    = [aws_sns_topic.alarms[0].arn]
}
