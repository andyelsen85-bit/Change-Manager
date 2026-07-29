import { pgTable, serial, text, timestamp, integer } from "drizzle-orm/pg-core";

// External changes: maintenance windows owned by third parties (providers,
// carriers, upstream vendors) that may impact our systems. They are NOT
// change requests — no approvals, no workflow, no CAB. Pure visibility on
// the Change Plannings calendar.
export const externalChangesTable = pgTable("external_changes", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  // Who performs the change (e.g. "Telco provider", "Datacenter Ops").
  provider: text("provider").notNull().default(""),
  description: text("description"),
  startAt: timestamp("start_at", { withTimezone: true }).notNull(),
  endAt: timestamp("end_at", { withTimezone: true }),
  createdBy: integer("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
