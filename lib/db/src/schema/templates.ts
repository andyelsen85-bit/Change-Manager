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
  prefilledScope: text("prefilled_scope"),
  prefilledRollbackPlan: text("prefilled_rollback_plan"),
  prefilledRiskAssessment: text("prefilled_risk_assessment"),
  prefilledImpactedServices: text("prefilled_impacted_services"),
  prefilledCommunicationsPlan: text("prefilled_communications_plan"),
  prefilledSuccessCriteria: text("prefilled_success_criteria"),
  isActive: boolean("is_active").notNull().default(true),
  usageCount: integer("usage_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type StandardTemplate = typeof standardTemplatesTable.$inferSelect;
export type InsertStandardTemplate = typeof standardTemplatesTable.$inferInsert;
