/** Team-name → URL slug + reverse lookup.
 *
 * `employee_annotation.team_user` is a free-text column (no FK, no
 * uniqueness constraint, possibly with spaces / umlauts). Routes need a
 * URL-safe identifier; we lowercase, strip diacritics, replace any
 * non-alphanumeric run with a single dash, trim leading/trailing dashes.
 *
 * Two teams that slugify identically would collide — accepted for now
 * (it's an internal HR tool; the team list is small and curated). If
 * it becomes a real risk, the cure is to add a uniqueness check in
 * `createTeam`.
 *
 * Reverse lookup is a small linear scan in `findTeamBySlug` since the
 * team set is tiny (< 20).
 */

export function teamSlug(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip combining marks (umlauts → ascii)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
