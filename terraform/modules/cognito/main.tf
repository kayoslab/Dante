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

  # MFA is mandatory for every user (migration 0011 dropped the per-user
  # `mfa_required` flag — the in-app gate became universal, and then
  # delegated to Cognito's native flow). The hosted UI walks new users
  # through TOTP or passkey enrollment at first sign-in; subsequent
  # sign-ins prompt for the chosen factor.
  mfa_configuration = "ON"

  software_token_mfa_configuration {
    enabled = true
  }

  # WebAuthn / passkey support. The relying-party ID binds credentials
  # to the app's public domain — a passkey enrolled here can't be
  # replayed at another site. `user_verification = "required"` forces
  # the authenticator to verify the user (biometric, PIN, or device
  # unlock) rather than just proving possession, which makes the
  # passkey itself a strong second factor on its own.
  web_authn_configuration {
    relying_party_id  = var.domain_name
    user_verification = "required"
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
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
    # Default Cognito sender. Switch to SES (d.alighieri@dante.example.com)
    # in prod once the domain is set up with DKIM/DMARC.
    email_sending_account = "COGNITO_DEFAULT"
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
  allowed_oauth_scopes                 = ["email", "openid", "profile"]
  supported_identity_providers         = ["COGNITO"] # Microsoft Entra ID added later via aws_cognito_identity_provider

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
