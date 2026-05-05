import { pgTable, serial, integer, text, timestamp, unique } from "drizzle-orm/pg-core";

// Per-change role assignment (Technical Reviewer / Implementer / Tester).
// Routing of approvals AND notifications consults this table first; falls
// back to the global role pool only when no per-change assignee exists.
export const changeAssigneesTable = pgTable(
  "change_assignees",
  {
    id: serial("id").primaryKey(),
    changeId: integer("change_id").notNull(),
    roleKey: text("role_key").notNull(),
    userId: integer("user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqChangeRole: unique().on(t.changeId, t.roleKey),
  }),
);

export type ChangeAssignee = typeof changeAssigneesTable.$inferSelect;
export type InsertChangeAssignee = typeof changeAssigneesTable.$inferInsert;
