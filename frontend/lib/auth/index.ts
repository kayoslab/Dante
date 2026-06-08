/** Auth.js entry point. Builds the singleton from `./config.ts` and
 * re-exports the handlers, `auth()`, `signIn()`, `signOut()`. */
import NextAuth from "next-auth";

import { authConfig } from "./config";

export const { handlers, auth, signIn, signOut, unstable_update } =
  NextAuth(authConfig);
export type { Role } from "./config";
