/** Auth.js v5 dispatches GET + POST for every `/api/auth/*` URL — sign-in,
 * sign-out, OAuth callback, session, CSRF token, etc. — through these
 * handlers. The provider id used in Auth.js URLs is "cognito" in prod and
 * "dev" in dev mode (see `lib/auth/config.ts`). */
import { handlers } from "@/lib/auth";

export const { GET, POST } = handlers;
