/** Settings list builder.
 *
 * Shared by `GET /api/config` and the server-side prefetch in
 * `app/settings/page.tsx`, so both produce the exact same JSON-plain
 * `Setting[]` wire shape (Date → ISO string). Auth stays in the route /
 * page; this module only shapes data.
 */
import "server-only";

import { listSettings } from "@/lib/db/queries/setting";

export async function buildSettingsList() {
  const rows = await listSettings();
  return rows.map((r) => ({
    key: r.key,
    value: r.value,
    description: r.description,
    updated_at: r.updated_at ? r.updated_at.toISOString() : null,
  }));
}
