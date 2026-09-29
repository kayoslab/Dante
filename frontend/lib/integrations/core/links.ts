/** `external_link` helpers and the auto-link rules.
 *
 * A link maps a record in an external tool — (integration, entity type,
 * external id) — to a Dante entity. Adapters never write links; the core
 * resolves them here, on behalf of every provider:
 *
 *   - the primary `people` source creates a `person → employee` link for
 *     every employee it materialises (see upsert.ts);
 *   - `auto_link_email` links persons to employees / freelancers whose
 *     e-mail matches (case-insensitive);
 *   - `auto_link_name` links companies to customers whose name matches;
 *   - manual links come from the UI through `lib/db/queries/*`.
 */
import type { Client } from "pg";

import type { DanteEntityType, ExternalEntityType, LinkOrigin } from "./capabilities";

export type LinkTarget = { dante_type: DanteEntityType; dante_id: number };

/** All links of one (integration, entity type) as a map keyed by external
 *  id. A person resolves to exactly one of employee / freelancer. */
export async function loadLinks(
  conn: Client,
  slug: string,
  entity_type: ExternalEntityType,
): Promise<Map<string, LinkTarget>> {
  const r = await conn.query<{ external_id: string; dante_type: DanteEntityType; dante_id: number }>(
    `SELECT external_id, dante_type, dante_id
       FROM external_link
      WHERE integration_slug = $1 AND entity_type = $2`,
    [slug, entity_type],
  );
  const out = new Map<string, LinkTarget>();
  for (const row of r.rows) out.set(row.external_id, { dante_type: row.dante_type, dante_id: row.dante_id });
  return out;
}

/** Insert a link unless one already exists for that external record. */
export async function insertLink(
  conn: Client,
  link: {
    integration_slug: string;
    entity_type: ExternalEntityType;
    external_id: string;
    dante_type: DanteEntityType;
    dante_id: number;
    origin: LinkOrigin;
  },
): Promise<boolean> {
  const r = await conn.query(
    `INSERT INTO external_link
       (integration_slug, entity_type, external_id, dante_type, dante_id, origin, mapped_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (integration_slug, entity_type, external_id) DO NOTHING`,
    [link.integration_slug, link.entity_type, link.external_id, link.dante_type, link.dante_id, link.origin],
  );
  return (r.rowCount ?? 0) > 0;
}

export type AutoLinkResult = { new_links: number; total: number };

/** Link unlinked persons of `slug` to employees (or freelancers) by
 *  case-insensitive e-mail. `total` counts every person link of that
 *  target type for the integration, matching the old per-table totals. */
export async function autoLinkPersonsByEmail(
  conn: Client,
  slug: string,
  target: "employee" | "freelancer",
): Promise<AutoLinkResult> {
  const candidates =
    target === "employee"
      ? await conn.query<{ external_id: string; dante_id: number }>(
          `SELECT p.external_id, ec.employee_id AS dante_id
             FROM external_person p
             JOIN employee_current ec ON LOWER(ec.email) = LOWER(p.email)
             LEFT JOIN external_link l
               ON l.integration_slug = p.integration_slug
              AND l.entity_type = 'person'
              AND l.external_id = p.external_id
            WHERE p.integration_slug = $1 AND l.external_id IS NULL`,
          [slug],
        )
      : await conn.query<{ external_id: string; dante_id: number }>(
          `SELECT p.external_id, f.freelancer_id AS dante_id
             FROM external_person p
             JOIN freelancer f ON LOWER(f.contact_email) = LOWER(p.email)
             LEFT JOIN external_link l
               ON l.integration_slug = p.integration_slug
              AND l.entity_type = 'person'
              AND l.external_id = p.external_id
            WHERE p.integration_slug = $1 AND l.external_id IS NULL
              AND p.email IS NOT NULL AND f.contact_email IS NOT NULL`,
          [slug],
        );
  let new_links = 0;
  for (const c of candidates.rows) {
    const inserted = await insertLink(conn, {
      integration_slug: slug,
      entity_type: "person",
      external_id: c.external_id,
      dante_type: target,
      dante_id: c.dante_id,
      origin: "auto:email",
    });
    if (inserted) new_links += 1;
  }
  const total = await conn.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM external_link
      WHERE integration_slug = $1 AND entity_type = 'person' AND dante_type = $2`,
    [slug, target],
  );
  return { new_links, total: Number(total.rows[0].n) };
}

/** Link unlinked companies of `slug` to customers by case-insensitive name. */
export async function autoLinkCompaniesByName(
  conn: Client,
  slug: string,
): Promise<AutoLinkResult> {
  const candidates = await conn.query<{ external_id: string; dante_id: number }>(
    `SELECT co.external_id, c.customer_id AS dante_id
       FROM external_company co
       JOIN customer c ON LOWER(c.name) = LOWER(co.name)
       LEFT JOIN external_link l
         ON l.integration_slug = co.integration_slug
        AND l.entity_type = 'company'
        AND l.external_id = co.external_id
      WHERE co.integration_slug = $1 AND l.external_id IS NULL`,
    [slug],
  );
  let new_links = 0;
  for (const c of candidates.rows) {
    const inserted = await insertLink(conn, {
      integration_slug: slug,
      entity_type: "company",
      external_id: c.external_id,
      dante_type: "customer",
      dante_id: c.dante_id,
      origin: "auto:name",
    });
    if (inserted) new_links += 1;
  }
  const total = await conn.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM external_link
      WHERE integration_slug = $1 AND entity_type = 'company'`,
    [slug],
  );
  return { new_links, total: Number(total.rows[0].n) };
}
