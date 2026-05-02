import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";

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
