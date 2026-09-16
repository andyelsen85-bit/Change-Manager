import { defineConfig } from "drizzle-kit";
import path from "path";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  dialect: "postgresql",
  // Created/maintained by API bootstrap, not Drizzle. Without these exclusions,
  // push treats active sessions and login-throttle state as obsolete tables.
  tablesFilter: ["!user_sessions", "!auth_login_throttle"],
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
