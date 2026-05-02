import { pgTable, serial, integer, text, timestamp, boolean } from "drizzle-orm/pg-core";

export const approvalsTable = pgTable("approvals", {
  id: serial("id").primaryKey(),
  changeId: integer("change_id").notNull(),
  roleKey: text("role_key").notNull(),
  approverId: integer("approver_id"),
  decision: text("decision").notNull().default("pending"),
  comment: text("comment"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  viaDeputy: boolean("via_deputy").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ApprovalRow = typeof approvalsTable.$inferSelect;
