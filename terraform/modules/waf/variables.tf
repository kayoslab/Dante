variable "environment" {
  description = "Environment slug — used in resource names + tags."
  type        = string
}

variable "name_prefix" {
  description = "Prefix for resource names."
  type        = string
  default     = "dante"
}

variable "alb_arn" {
  description = "ALB ARN to associate the Web ACL with."
  type        = string
}

# --- managed rule groups ---------------------------------------------------

variable "enable_common_rules" {
  description = "AWSManagedRulesCommonRuleSet — broad OWASP coverage (XSS, basic injection, malicious URI patterns). Highest WCU cost (~700) but the single most useful group. Keep on."
  type        = bool
  default     = true
}

variable "enable_known_bad_inputs" {
  description = "AWSManagedRulesKnownBadInputsRuleSet — known exploit signatures (CVE-scanning bots, log4shell probes, etc). Cheap and high-signal."
  type        = bool
  default     = true
}

variable "enable_sqli_rules" {
  description = "AWSManagedRulesSQLiRuleSet — SQL injection patterns. Useful even with parameterized queries (defense in depth) but can cause false positives on legitimate SQL-like content in form fields. Watch CloudWatch metrics after enabling."
  type        = bool
  default     = true
}

variable "enable_ip_reputation" {
  description = "AWSManagedRulesAmazonIpReputationList — known bot / scanner / botnet IPs. Cheap (~25 WCU), high value."
  type        = bool
  default     = true
}

variable "enable_anonymous_ip_block" {
  description = "AWSManagedRulesAnonymousIpList — blocks Tor exits and known public VPNs / proxies. Tighter than ip_reputation but can lock out legitimate VPN users. Off by default; turn on if abuse warrants it."
  type        = bool
  default     = false
}

# --- custom rules ----------------------------------------------------------

variable "auth_path_rate_limit_per_5min" {
  description = "Per-IP request cap on `/api/auth/*` over 5 minutes. Protects against credential-stuffing on the sign-in endpoint. Set to 0 to disable. 100 = ~20 requests/min, well above any legitimate user."
  type        = number
  default     = 100
}

variable "global_rate_limit_per_5min" {
  description = "Per-IP request cap across the whole site over 5 minutes. Catches scraper bots. 2000 = ~7 req/sec, generous for a 40-user app where each page emits a handful of API calls."
  type        = number
  default     = 2000
}

variable "geo_allow_list" {
  description = "ISO 3166-1 alpha-2 country codes to allow. Empty list = no geo filter. Example: [\"DE\", \"AT\", \"CH\", \"NL\", \"FR\"] for DACH+Benelux. Be careful — admins traveling outside the list will be blocked."
  type        = list(string)
  default     = []
}

# --- logging + metrics -----------------------------------------------------

variable "enable_logging" {
  description = "Ship WAF events to a CloudWatch log group. ~€0.50/GB ingested. Useful for the first month while tuning rules; can disable once steady-state."
  type        = bool
  default     = true
}

variable "log_retention_days" {
  description = "How long to retain WAF logs in CloudWatch."
  type        = number
  default     = 30
}

variable "alarm_email_addresses" {
  description = "Subscribers for the blocked-spike alarm. Each gets a confirmation email after first apply."
  type        = list(string)
  default     = []
}

variable "blocked_spike_threshold" {
  description = "Trigger the alarm when WAF blocks more than this many requests in a 5-minute window. Tune up after observing baseline traffic — initial value is conservative to catch anomalies early."
  type        = number
  default     = 500
}
