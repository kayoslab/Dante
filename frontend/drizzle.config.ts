import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

// Load env from the repo root (one level up from frontend/) so DATABASE_URL
// is picked up regardless of which directory drizzle-kit is invoked from.
config({ path: "../.env" });

export default defineConfig({
  schema: "./lib/db/schema",
  out: "./lib/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  verbose: true,
  strict: true,
});
