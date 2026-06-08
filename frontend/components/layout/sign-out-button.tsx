import { signOut } from "@/lib/auth";

/** Server Component wrapping a Server Action that ends the session.
 * Avoids the client-side `signOut()` round trip — submit-to-server is
 * simpler and works without JS. */
export function SignOutButton() {
  async function action() {
    "use server";
    await signOut({ redirectTo: "/login" });
  }
  return (
    <form action={action}>
      <button
        type="submit"
        className="rounded border border-border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground hover:border-foreground transition"
      >
        Sign out
      </button>
    </form>
  );
}
