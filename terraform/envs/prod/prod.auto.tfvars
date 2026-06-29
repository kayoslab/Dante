/**
 * Prod var defaults loaded automatically by terraform.
 *
 * Pin values that are stable per-env so manual `terraform plan / apply`
 * from an operator workstation doesn't prompt for them — and so a typo
 * at the prompt can't quietly rewrite the trust policy with a malformed
 * value (which happened once; the wrong `github_repository` made every
 * subsequent OIDC assumption fail until the policy was restored).
 *
 * `app_image_uri` is intentionally NOT pinned here — it rotates on every
 * deploy, and CI injects the current value via `-var "app_image_uri=…"`.
 * Pinning it would either go stale or fight with CI's value.
 *
 * Neither of these is sensitive:
 *  - github_repository is the public org/repo slug.
 *  - hosted_zone_id is the Route 53 zone ID for our DNS apex.
 */

github_repository = "your-org/dante"
hosted_zone_id    = "Z0123456789ABCDEFGHIJ"

# TEMPORARY — pentest window. Detaches the Web ACL from the public ALB
# so the tester sees the raw application attack surface without WAF
# filtering (managed rules, rate limits, geo all bypassed). The Web ACL
# definition stays in place; this only toggles the association.
#
# REVERT TO `true` (or remove this line) as soon as the pentest is done.
waf_enabled = false
