import { pgTable, serial, text, integer, timestamp, boolean } from "drizzle-orm/pg-core";

export const changeRequestsTable = pgTable("change_requests", {
  id: serial("id").primaryKey(),
  ref: text("ref").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  track: text("track").notNull(),
  status: text("status").notNull().default("draft"),
  risk: text("risk").notNull().default("low"),
  impact: text("impact").notNull().default("low"),
  priority: text("priority").notNull().default("medium"),
  category: text("category").notNull().default("general"),
  // Optional pre-prod testing flag (Normal track). When true the workflow
  // includes an `in_preprod_testing` step before `scheduled` which the
  // Implementer drives.
  hasPreprodEnv: boolean("has_preprod_env").notNull().default(false),
  preprodEnvUrl: text("preprod_env_url"),
  ownerId: integer("owner_id").notNull(),
  assigneeId: integer("assignee_id"),
  templateId: integer("template_id"),
  cabMeetingId: integer("cab_meeting_id"),
  plannedStart: timestamp("planned_start", { withTimezone: true }),
  plannedEnd: timestamp("planned_end", { withTimezone: true }),
  actualStart: timestamp("actual_start", { withTimezone: true }),
  actualEnd: timestamp("actual_end", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type ChangeRow = typeof changeRequestsTable.$inferSelect;
export type InsertChange = typeof changeRequestsTable.$inferInsert;
