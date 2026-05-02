import { pgTable, serial, integer, text, timestamp, jsonb } from "drizzle-orm/pg-core";

export const auditLogTable = pgTable("audit_log", {
  id: serial("id").primaryKey(),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
  actorId: integer("actor_id"),
  actorName: text("actor_name").notNull().default("system"),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: integer("entity_id"),
  summary: text("summary").notNull().default(""),
  ipAddress: text("ip_address").notNull().default(""),
  userAgent: text("user_agent").notNull().default(""),
  before: jsonb("before"),
  after: jsonb("after"),
});

export type AuditRow = typeof auditLogTable.$inferSelect;
