import { pgTable, serial, text, boolean, timestamp, integer } from "drizzle-orm/pg-core";

export const standardTemplatesTable = pgTable("standard_templates", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  category: text("category").notNull().default("general"),
  risk: text("risk").notNull().default("low"),
  impact: text("impact").notNull().default("low"),
  defaultPriority: text("default_priority").notNull().default("medium"),
  autoApprove: boolean("auto_approve").notNull().default(true),
  bypassCab: boolean("bypass_cab").notNull().default(true),
  prefilledPlanning: text("prefilled_planning"),
  prefilledTestPlan: text("prefilled_test_plan"),
  isActive: boolean("is_active").notNull().default(true),
  usageCount: integer("usage_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type StandardTemplate = typeof standardTemplatesTable.$inferSelect;
export type InsertStandardTemplate = typeof standardTemplatesTable.$inferInsert;
