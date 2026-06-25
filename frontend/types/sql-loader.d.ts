/** Imports of `*.sql` files resolve to the file's contents as a
 * string at build time. esbuild's text loader handles the bundle
 * (`scripts/build-migrate.ts`); for `tsx` / next dev, we apply the
 * same shape so TypeScript accepts the import. */
declare module "*.sql" {
  const content: string;
  export default content;
}
