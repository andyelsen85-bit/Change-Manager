import { pgTable, serial, integer, text, boolean, unique } from "drizzle-orm/pg-core";

// In-app notifications were removed — only email is delivered. The
// `inAppEnabled` column is intentionally NOT present in this schema; older
// backups that include it are filtered transparently by lib/backup.ts.
export const notificationPreferencesTable = pgTable(
  "notification_preferences",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull(),
    eventKey: text("event_key").notNull(),
    emailEnabled: boolean("email_enabled").notNull().default(true),
  },
  (t) => ({
    uniqUserEvent: unique().on(t.userId, t.eventKey),
  }),
);

export type NotificationPref = typeof notificationPreferencesTable.$inferSelect;
