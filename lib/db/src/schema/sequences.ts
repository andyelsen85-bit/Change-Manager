import { pgTable, text, integer } from "drizzle-orm/pg-core";

// Per-track ref counter, e.g. NOR-1234, STD-12, EMR-5
export const refCountersTable = pgTable("ref_counters", {
  prefix: text("prefix").primaryKey(),
  counter: integer("counter").notNull().default(0),
});
