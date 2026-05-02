import { pgTable, integer, text, boolean, timestamp } from "drizzle-orm/pg-core";

export const planningRecordsTable = pgTable("planning_records", {
  changeId: integer("change_id").primaryKey(),
  scope: text("scope").notNull().default(""),
  implementationPlan: text("implementation_plan").notNull().default(""),
  rollbackPlan: text("rollback_plan").notNull().default(""),
  riskAssessment: text("risk_assessment").notNull().default(""),
  impactedServices: text("impacted_services").notNull().default(""),
  communicationsPlan: text("communications_plan").notNull().default(""),
  successCriteria: text("success_criteria").notNull().default(""),
  signedOff: boolean("signed_off").notNull().default(false),
  signedOffAt: timestamp("signed_off_at", { withTimezone: true }),
  signedOffBy: text("signed_off_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type PlanningRow = typeof planningRecordsTable.$inferSelect;
