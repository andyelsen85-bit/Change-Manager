import { pgTable, serial, integer, text, boolean, unique } from "drizzle-orm/pg-core";

export const rolesTable = pgTable("roles", {
  key: text("key").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  allowsDeputy: boolean("allows_deputy").notNull().default(true),
});

export const roleAssignmentsTable = pgTable(
  "role_assignments",
  {
    id: serial("id").primaryKey(),
    roleKey: text("role_key").notNull(),
    userId: integer("user_id").notNull(),
    isDeputy: boolean("is_deputy").notNull().default(false),
    primaryAssignmentId: integer("primary_assignment_id"),
  },
  (t) => ({
    uniqRoleUser: unique().on(t.roleKey, t.userId, t.isDeputy),
  }),
);

export type Role = typeof rolesTable.$inferSelect;
export type RoleAssignment = typeof roleAssignmentsTable.$inferSelect;
