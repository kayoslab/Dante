import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { employeeCurrent } from "./employee";

/** Application users.
 *
 * Identity is held in Cognito (production) or stubbed in dev mode. This
 * row links the Cognito identity to an `employee_current` employee and
 * caches role + lifecycle state.
 *
 * `role` is the source of truth in dev mode. In prod, the JWT's
 * `cognito:groups` claim is authoritative; we update this column to
 * match on every sign-in so the /settings/users UI can show current
 * state without round-tripping to Cognito.
 *
 * Role changes via the UI write here AND issue an
 * AdminAddUserToGroup/AdminRemoveUserFromGroup against Cognito (prod
 * only). The user's next sign-in (or token refresh) picks up the new
 * group claim. */
export const appUser = pgTable(
  "app_user",
  {
    user_id: uuid().primaryKey().defaultRandom(),
    /** Cognito's stable user identifier (`sub` claim). In dev mode we
     * stub this as `dev:<email>` so the column stays NOT NULL; on first
     * real Cognito sign-in we update the matching row by email. */
    cognito_sub: text().notNull(),
    email: text().notNull(),
    /** Optional link to the employee this user represents. NULL means
     * the user has no Personio record (external auditor, or unlinked). */
    employee_id: integer().references(() => employeeCurrent.employee_id, {
      onDelete: "set null",
    }),
    role: text()
      .notNull()
      .default("employee")
      .$type<"admin" | "manager" | "employee">(),
    /** True when suspended from sign-in. We don't delete rows
     * (audit_log FKs point here); we toggle this flag instead. Mirrors
     * Cognito's AdminDisableUser / AdminEnableUser. */
    is_disabled: boolean().notNull().default(false),
    /** When true, the user must complete TOTP at sign-in. Defaults true
     * for admin/manager (set by `inviteUserAction` + a setRole trigger);
     * users can opt-in for "employee" via `/profile`. */
    mfa_required: boolean().notNull().default(false),
    /** Base32-encoded TOTP secret. NULL means the user hasn't enrolled
     * yet — the setup flow will issue one. Encrypted at rest by Postgres
     * TDE; application-layer encryption is a later upgrade if scope grows. */
    mfa_secret: text(),
    /** When set, the user has completed enrollment. Cleared on admin
     * reset (e.g. lost device). `mfa_required && mfa_enrolled_at IS NULL`
     * → user is forced through setup before they can use the app. */
    mfa_enrolled_at: timestamp({ mode: "date" }),
    created_at: timestamp({ mode: "date" }).notNull().defaultNow(),
    last_login_at: timestamp({ mode: "date" }),
  },
  (t) => [
    uniqueIndex("app_user_cognito_sub_idx").on(t.cognito_sub),
    // Case-insensitive lookup since email is the join key with Cognito and
    // with employee_current. Postgres does this via LOWER() expression idx.
    uniqueIndex("app_user_email_idx").on(sql`LOWER(${t.email})`),
    index("app_user_employee_idx").on(t.employee_id),
  ],
);

/** Append-only audit trail for security-sensitive reads + every admin
 * action. Retention policy 1 year (configurable later); never UPDATE,
 * only INSERT, so the table is auto-archivable.
 *
 * Actions to log (non-exhaustive): view_employee_detail, view_salary,
 * view_audit_log, sync_triggered, user_role_changed, user_invited,
 * user_disabled, setting_changed. */
export const appAuditLog = pgTable(
  "app_audit_log",
  {
    audit_id: bigserial({ mode: "number" }).primaryKey(),
    user_id: uuid().references(() => appUser.user_id, { onDelete: "set null" }),
    action: text().notNull(),
    target_type: text().notNull(),
    target_id: text(),
    ip_address: text(), // inet would be tidier but Drizzle's pg-core doesn't expose it yet
    user_agent: text(),
    occurred_at: timestamp({ mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    index("app_audit_user_at_idx").on(t.user_id, t.occurred_at),
    index("app_audit_action_at_idx").on(t.action, t.occurred_at),
  ],
);
