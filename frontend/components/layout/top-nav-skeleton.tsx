import Link from "next/link";

/** Suspense fallback for `TopNav`. Same height and border as the real
 * bar so the page below doesn't shift when the session-gated nav
 * streams in. Only the brand is static; links depend on the role. */
export function TopNavSkeleton() {
  return (
    <nav className="border-b bg-background">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-8 px-4">
        <Link href="/" className="font-semibold tracking-tight">
          Dante
        </Link>
      </div>
    </nav>
  );
}
