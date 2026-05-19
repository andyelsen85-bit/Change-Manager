import { pgTable, serial, integer, text, boolean } from "drizzle-orm/pg-core";

// Admin-configurable notification routing rules.
//
// Each row is one recipient rule attached to a notification event. The
// resolver in artifacts/api-server/src/lib/notification-routing.ts evaluates
// every active rule for an event and unions the resulting user IDs.
//
// kind:
//   "owner"            -> the change owner
//   "assignee"         -> the change assignee (if set)
//   "role"             -> all users assigned to roleKey in role_assignments
//   "per_change_role"  -> per-change assignees for roleKey (falls back to the
//                         global role pool when no per-change assignee exists)
//
// trackFilter (nullable): when set ("normal" | "emergency" | "standard"),
// the rule only fires for changes of that track. NULL means "all tracks".
//
// excludeActor: when true, the user who triggered the event (actorUserId) is
// dropped from the recipient set produced by this rule. Used for comment.added
// so the author doesn't get emailed their own comment.
export const notificationRoutingRulesTable = pgTable("notification_routing_rules", {
  id: serial("id").primaryKey(),
  eventKey: text("event_key").notNull(),
  kind: text("kind").notNull(),
  roleKey: text("role_key"),
  trackFilter: text("track_filter"),
  excludeActor: boolean("exclude_actor").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
});

export type NotificationRoutingRule = typeof notificationRoutingRulesTable.$inferSelect;
export type InsertNotificationRoutingRule = typeof notificationRoutingRulesTable.$inferInsert;
