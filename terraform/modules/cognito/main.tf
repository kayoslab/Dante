/**
 * Cognito User Pool for Dante.
 *
 * What this module provisions:
 *   - One User Pool with email as the sign-in attribute, MFA optional at
 *     the pool level (admin-MFA is enforced in the app, day 2/3).
 *   - Password policy: 12+ chars, mixed case + digit + symbol.
 *   - Three groups: admin / manager / employee. The app reads
 *     `cognito:groups` from the JWT to authorize.
 *   - One confidential app client with PKCE + auth-code flow. Auth.js v5
 *     uses the client_secret server-side.
 *   - One Cognito-hosted OAuth domain (used by the OIDC endpoints —
 *     we do not use the Hosted UI).
 *   - Seed users for `seed_admin_emails`, each placed in the admin group.
 *     Cognito generates a temp password and emails the welcome message;
 *     the user must change it on first sign-in.
 *
 * What this module does NOT do (yet):
 *   - Federated IdPs (Microsoft Entra ID / Google). Adding them later is
 *     an `aws_cognito_identity_provider` resource pointing to Microsoft's
 *     OIDC endpoint, plus attribute mapping — no app code change.
 *   - Custom SES sender. Cognito's default sender is rate-limited to ~50
 *     emails/day, which is fine for dev. Switch to SES with a verified
 *     domain (d.alighieri@dante.example.com) in prod.
 */
locals {
  name = "${var.name_prefix}-${var.environment}"

  base_tags = merge(
    {
      App         = var.name_prefix
      Environment = var.environment
      ManagedBy   = "terraform"
      Module      = "cognito"
    },
    var.tags,
  )
}

# ----------------------------------------------------------------------------
# User Pool
# ----------------------------------------------------------------------------

resource "aws_cognito_user_pool" "this" {
  name = "${local.name}-userpool"

  # Pool pricing tier. PLUS is required to enable Threat Protection
  # (advanced_security_mode below). ESSENTIALS is the prior default.
  user_pool_tier = var.user_pool_tier

  # Email is the sign-in identifier. Username (the internal Cognito identifier)
  # is auto-generated and stable — we store it as `cognito_sub` on app_user.
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  password_policy {
    minimum_length    = 12
    require_lowercase = true
    require_uppercase = true
    require_numbers   = true
    require_symbols   = true
    # 7 days is Cognito's max for the welcome temp-password email; after that
    # the user must be re-invited.
    temporary_password_validity_days = 7
  }

  sign_in_policy {
    allowed_first_auth_factors = ["PASSWORD"]
  }

  # MFA is mandatory for every user (migration 0011 dropped the per-user
  # `mfa_required` flag — the in-app gate became universal, and then
  # delegated to Cognito's native flow). The hosted UI walks new users
  # through TOTP enrollment at first sign-in; subsequent sign-ins
  # prompt for the TOTP code.
  mfa_configuration = "ON"

  software_token_mfa_configuration {
    enabled = true
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  # Pre Token Generation V3 trigger — runs on every access/ID token
  # issuance (incl. refresh). The Lambda inspects the user's group
  # membership and rewrites the `scope` claim to the intersection of
  # (requested scopes, scopes the group permits). Without this an
  # `employee` user consenting to the agent client's full scope list
  # would receive `dante-agents/read:salaries` in the access token.
  #
  # Optional — when `pre_token_generation_lambda_arn` is null the trigger
  # isn't configured, and the issued tokens carry whatever scopes the
  # user consented to (fine for dev where only the resource server is
  # in play). Prod always sets it.
  dynamic "lambda_config" {
    for_each = var.pre_token_generation_lambda_arn == null ? [] : [1]
    content {
      pre_token_generation_config {
        lambda_arn     = var.pre_token_generation_lambda_arn
        lambda_version = "V3_0"
      }
    }
  }

  admin_create_user_config {
    # Only admins (via the app) or Terraform-managed seeds create users.
    # No public self-signup.
    allow_admin_create_user_only = true

    invite_message_template {
      email_subject = "Your Dante account is ready"
      email_message = <<-EOT
        <p>Hi,</p>
        <p>You've been invited to Dante. Sign in with the temporary credentials below — you'll be asked to set a new password on first sign-in.</p>
        <p><strong>Email:</strong> {username}<br><strong>Temporary password:</strong> {####}</p>
        <p>Sign in at the URL your administrator shared with you.</p>
      EOT
      # Cognito requires both {username} and {####} placeholders in the
      # SMS body even though we don't use SMS — the provider validates
      # the template against the spec regardless.
      sms_message = "Dante temp password for {username}: {####}"
    }
  }

  email_configuration {
    # When `ses_source_arn` is set we use SES so messages come from a
    # domain we own (DKIM + DMARC aligned, no quarantine). Cognito's
    # default sender is rate-limited to ~50/day and routinely filtered
    # by corporate inboxes, so it's only useful for dev.
    email_sending_account  = var.ses_source_arn == null ? "COGNITO_DEFAULT" : "DEVELOPER"
    source_arn             = var.ses_source_arn
    from_email_address     = var.ses_from_email_address
    reply_to_email_address = var.ses_reply_to_email_address
  }

  # Cognito Advanced Security (now Plus tier feature) — adaptive auth,
  # IP-based throttling, compromised-credentials detection, suspicious-
  # activity events. Required when an account is allowed to use the
  # hosted UI from anywhere on the internet (which is our case — the
  # hosted UI domain is publicly resolvable). Without ASM, brute-force
  # protection relies on Cognito's fixed 5-attempt lockout only.
  # Cost: ~$0.05 per MAU (≈ $2/mo at 40 users); turn off if cost is an
  # issue. The "AUDIT" level only logs risk events to CloudTrail
  # without taking action — "ENFORCED" is the right default for prod.
  user_pool_add_ons {
    advanced_security_mode = var.advanced_security_mode
  }

  # Schema: standard `email`. We could add custom attributes here (e.g.
  # `employee_id`) but it's cleaner to keep that link in app_user rather than
  # synchronising it across Cognito + Postgres.
  schema {
    name                     = "email"
    attribute_data_type      = "String"
    required                 = true
    mutable                  = true
    developer_only_attribute = false
    string_attribute_constraints {
      min_length = 5
      max_length = 254
    }
  }

  # Token validity is set per-app-client below; pool-level config kept default.

  tags = local.base_tags

  lifecycle {
    # Cognito's `lifecycle.prevent_destroy` only accepts a literal, so we
    # hardcode `true` rather than parameterizing per environment. The
    # friction is intentional: deleting the user pool drops every user
    # account, every group membership, and invalidates every session.
    #
    # To intentionally destroy in dev, temporarily flip this to `false`,
    # apply, then flip back — the manual step is the feature.
    prevent_destroy = true
    ignore_changes = [
      # The seed user creates a verification email cooldown timestamp on
      # the pool that Terraform doesn't model; ignore drift on it.
      schema,
    ]
  }
}

# ----------------------------------------------------------------------------
# OAuth domain — used for /oauth2/* endpoints (NOT the Hosted UI).
# Domain prefix must be globally unique within the region.
# ----------------------------------------------------------------------------

resource "aws_cognito_user_pool_domain" "this" {
  domain       = "${local.name}-${random_id.domain_suffix.hex}"
  user_pool_id = aws_cognito_user_pool.this.id
  # 2 = Managed Login (modern hosted UI with passkey-at-sign-in,
  # visual branding designer). 1 = classic. The matching
  # `aws_cognito_managed_login_branding` resource below configures
  # the visual asset bundle; without that, Managed Login falls back
  # to the Cognito-provided defaults.
  managed_login_version = 2
}

# Managed Login branding for the app client.
#
# Bootstrap step — run once after first apply (the terraform AWS provider
# doesn't yet wrap `aws_cognito_managed_login_branding`; tracked upstream
# in hashicorp/terraform-provider-aws #40677):
#
#   aws cognito-idp create-managed-login-branding \
#     --user-pool-id <user_pool_id> \
#     --client-id <client_id> \
#     --use-cognito-provided-values \
#     --region eu-central-1
#
# Without that resource the client falls back to the classic hosted UI
# even when `managed_login_version = 2` is set on the domain — the
# branding's presence is what flips Managed Login on. Once the provider
# wraps the resource, codify it here so the asset bundle (colors / logo /
# fonts) becomes terraform-managed too.

# Optional custom Cognito hosted-UI domain. WebAuthn passkeys are bound
# to an RPID that must be a registrable suffix of the page origin —
# without a custom domain on the same eTLD+1 as the app, passkeys
# registered on the app can't be used at sign-in (the SecurityError
# "RPID did not match the origin" we hit in prod).
resource "aws_cognito_user_pool_domain" "custom" {
  count                 = var.custom_domain_name == null ? 0 : 1
  domain                = var.custom_domain_name
  certificate_arn       = var.custom_domain_cert_arn
  user_pool_id          = aws_cognito_user_pool.this.id
  managed_login_version = 2
}

resource "random_id" "domain_suffix" {
  byte_length = 4
}

# ----------------------------------------------------------------------------
# Groups → roles
# ----------------------------------------------------------------------------

resource "aws_cognito_user_group" "admin" {
  name         = "admin"
  user_pool_id = aws_cognito_user_pool.this.id
  description  = "Full access including /settings/* and audit log."
  precedence   = 1
}

resource "aws_cognito_user_group" "manager" {
  name         = "manager"
  user_pool_id = aws_cognito_user_pool.this.id
  description  = "Access to all org data except /settings/*."
  precedence   = 10
}

resource "aws_cognito_user_group" "employee" {
  name         = "employee"
  user_pool_id = aws_cognito_user_pool.this.id
  description  = "Calendar, employee list (no detail), own profile only."
  precedence   = 100
}

# ----------------------------------------------------------------------------
# App client — confidential (server-side Next.js holds the secret).
# ----------------------------------------------------------------------------

resource "aws_cognito_user_pool_client" "app" {
  name         = "${local.name}-app"
  user_pool_id = aws_cognito_user_pool.this.id

  # Confidential client: Auth.js runs server-side and keeps the secret.
  generate_secret = true

  # PKCE is enforced for code flow (Auth.js handles the verifier/challenge).
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_flows_user_pool_client = true
  # `aws.cognito.signin.user.admin` is required for the access token to
  # call user-scoped cognito-idp APIs (ChangePassword, AssociateSoftwareToken,
  # ListWebAuthnCredentials, etc.) from `/profile` self-service. Without
  # it Cognito returns `NotAuthorizedException: Access Token does not have
  # required scopes` on every self-service call.
  allowed_oauth_scopes = [
    "email",
    "openid",
    "profile",
    "aws.cognito.signin.user.admin",
  ]
  supported_identity_providers = ["COGNITO"] # Microsoft Entra ID added later via aws_cognito_identity_provider

  callback_urls = var.callback_urls
  logout_urls   = var.logout_urls

  # Token lifetimes:
  #   - access/id: 1 hour (short, frequent refresh)
  #   - refresh:   7 days. Was 30; tightened after the pre-launch pen
  #                test (M-007). A 30-day refresh token means a phished
  #                token gives 30 days of access; 7 days bounds the
  #                blast radius to a working week without forcing daily
  #                re-sign-in for the actual user. Auth.js's session
  #                JWT runs for 7 days anyway, so the two are aligned.
  access_token_validity  = 1
  id_token_validity      = 1
  refresh_token_validity = 7
  token_validity_units {
    access_token  = "hours"
    id_token      = "hours"
    refresh_token = "days"
  }

  # Honor RevokeToken when the user signs out so a stolen access token
  # can't outlive the session. Defaults on for new app clients but
  # we declare it explicitly to lock the behavior.
  enable_token_revocation = true

  # Auth flow restrictions: disable username/password from the app client.
  # All sign-ins go through the OIDC code flow (Auth.js handles it).
  explicit_auth_flows = [
    "ALLOW_USER_SRP_AUTH",      # used by Cognito's own UI / SRP-aware clients
    "ALLOW_REFRESH_TOKEN_AUTH", # required for refresh
  ]

  prevent_user_existence_errors = "ENABLED" # don't leak whether an email exists

  read_attributes  = ["email", "email_verified"]
  write_attributes = ["email"]
}

# ----------------------------------------------------------------------------
# Resource Server for `/api/agent/*` — custom scopes consumed by Vercel
# EVE and any future agent integrations.
#
# Cognito formats each issued scope string as `<identifier>/<scope-name>`,
# so a token granted `read:projects` arrives in the `scope` claim as
# `dante-agents/read:projects`. The `agent-scopes.ts` catalog in the
# app mirrors these names without the prefix; the JWT validator strips
# the prefix before matching against the catalog.
#
# Adding a scope here is one edit. The Pre-Token Generation Lambda (see
# below) gates which group can mint each scope so an `employee` user
# consenting to all scopes never receives `read:salaries` in the
# issued access token even if the agent app client lists it.
# ----------------------------------------------------------------------------

resource "aws_cognito_resource_server" "agents" {
  identifier   = "dante-agents"
  name         = "${local.name}-agents"
  user_pool_id = aws_cognito_user_pool.this.id

  dynamic "scope" {
    for_each = var.agent_scopes
    content {
      scope_name        = scope.value.name
      scope_description = scope.value.description
    }
  }
}

# ----------------------------------------------------------------------------
# App client for agent integrations (Vercel EVE today; future agents
# share this client unless one needs different callback URLs).
#
# Distinct from the web-app client because:
#   - Different callback URLs (agent app, not the Dante web UI).
#   - PUBLIC client (no secret) — most agent frameworks ship as
#     installable apps that can't safely hold a confidential secret;
#     PKCE is mandatory instead.
#   - Different scope set: dante-agents/* plus openid (so we can read
#     the `sub` claim from the access token JWT for audit attribution).
# ----------------------------------------------------------------------------

resource "aws_cognito_user_pool_client" "agents" {
  name         = "${local.name}-agents"
  user_pool_id = aws_cognito_user_pool.this.id

  # Public client. PKCE is enforced for the code flow; without a secret
  # the only authentication factor on the token exchange is the
  # code_verifier the agent kept locally. Agent frameworks (EVE,
  # Claude Desktop, etc.) ship as installable apps with no safe place
  # to store a server-side secret.
  generate_secret = false

  allowed_oauth_flows                  = ["code"]
  allowed_oauth_flows_user_pool_client = true

  # `openid` is needed so the issued tokens include the `sub` claim
  # (Cognito user identifier) — the API uses it to look up the local
  # app_user row for audit attribution. All other scopes are the
  # custom agent scopes from the resource server above.
  allowed_oauth_scopes = concat(
    ["openid"],
    [for s in var.agent_scopes : "${aws_cognito_resource_server.agents.identifier}/${s.name}"],
  )
  supported_identity_providers = ["COGNITO"]

  callback_urls = var.agent_client_callback_urls
  logout_urls   = var.agent_client_logout_urls

  # Access token lifetime: 1 hour. Refresh: configurable via variable
  # (default 30 days) because agents typically run for weeks without
  # human re-auth; tighter than the web client because the threat
  # model differs (an exfiltrated agent refresh token is harder to
  # detect than a stolen web session). 90 days is the AWS max.
  access_token_validity  = 1
  id_token_validity      = 1
  refresh_token_validity = var.agent_refresh_token_validity_days
  token_validity_units {
    access_token  = "hours"
    id_token      = "hours"
    refresh_token = "days"
  }

  enable_token_revocation = true

  # Agents authenticate via the authorization code flow only — no
  # password / SRP entrypoint. Refresh is needed for long-lived agents.
  explicit_auth_flows = [
    "ALLOW_REFRESH_TOKEN_AUTH",
  ]

  prevent_user_existence_errors = "ENABLED"

  read_attributes  = ["email", "email_verified"]
  write_attributes = []
}

# ----------------------------------------------------------------------------
# Seed admins — one Cognito user per email, each added to the admin group.
# Cognito generates a temp password and emails the invite automatically.
# ----------------------------------------------------------------------------

resource "aws_cognito_user" "seed_admin" {
  for_each = toset(var.seed_admin_emails)

  user_pool_id = aws_cognito_user_pool.this.id
  username     = each.value

  # MessageAction not set → Cognito sends the welcome email with a generated
  # temp password (see admin_create_user_config.invite_message_template above).
  attributes = {
    email          = each.value
    email_verified = "true"
  }

  # Ignore drift after creation — the user changes their password and may
  # set MFA, neither of which we want Terraform fighting.
  lifecycle {
    ignore_changes = [
      attributes,
      temporary_password,
      password,
      message_action,
      desired_delivery_mediums,
    ]
  }
}

resource "aws_cognito_user_in_group" "seed_admin_in_admin" {
  for_each = aws_cognito_user.seed_admin

  user_pool_id = aws_cognito_user_pool.this.id
  group_name   = aws_cognito_user_group.admin.name
  username     = each.value.username

  depends_on = [aws_cognito_user_group.admin]
}
