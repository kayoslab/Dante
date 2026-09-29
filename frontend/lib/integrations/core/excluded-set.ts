/** Shared upsert helper for sync writes.
 *
 * Every sync write follows the same shape:
 *   INSERT ... ON CONFLICT (pk) DO UPDATE SET col1 = excluded.col1, ...
 *
 * This helper builds the `set` map from a list of column names. Drizzle
 * itself doesn't expose `excluded.*` as a typed expression, so we drop to
 * `sql.raw` for each column. Schema drift is still caught at compile
 * time on the insert values via `$inferInsert`, which is the real point.
 */
import { sql, type SQL } from "drizzle-orm";

/** Build a `set` object for `db.insert().onConflictDoUpdate({ set })`.
 * Pass every column you want pulled from the EXCLUDED row (i.e. the
 * values you just tried to insert). Don't pass the primary key. */
export function excludedSet<K extends string>(cols: readonly K[]): Record<K, SQL> {
  const set = {} as Record<K, SQL>;
  for (const col of cols) {
    set[col] = sql.raw(`excluded.${col}`);
  }
  return set;
}
