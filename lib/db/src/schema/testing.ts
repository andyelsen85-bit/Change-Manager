import { pgTable, integer, text, timestamp, jsonb } from "drizzle-orm/pg-core";

export type TestCase = {
  name: string;
  steps: string;
  expectedResult: string;
  actualResult: string;
  status: "pending" | "passed" | "failed" | "blocked";
};

export const testRecordsTable = pgTable("test_records", {
  changeId: integer("change_id").primaryKey(),
  testPlan: text("test_plan").notNull().default(""),
  environment: text("environment").notNull().default(""),
  overallResult: text("overall_result").notNull().default("pending"),
  notes: text("notes").notNull().default(""),
  testedBy: text("tested_by"),
  testedAt: timestamp("tested_at", { withTimezone: true }),
  cases: jsonb("cases").$type<TestCase[]>().notNull().default([]),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const pirRecordsTable = pgTable("pir_records", {
  changeId: integer("change_id").primaryKey(),
  outcome: text("outcome").notNull().default("successful"),
  objectivesMet: text("objectives_met").notNull().default(""),
  issuesEncountered: text("issues_encountered").notNull().default(""),
  lessonsLearned: text("lessons_learned").notNull().default(""),
  followupActions: text("followup_actions").notNull().default(""),
  completedBy: text("completed_by"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type TestRow = typeof testRecordsTable.$inferSelect;
export type PirRow = typeof pirRecordsTable.$inferSelect;
