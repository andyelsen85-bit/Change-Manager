import { pgTable, serial, integer, text, timestamp, index } from "drizzle-orm/pg-core";

// Outbound notification queue. Every call to notify() inserts one row per
// recipient — the background worker (lib/notification-worker.ts in the API)
// drains the queue on a configurable interval (notification_settings.batch_interval_minutes)
// and sends one consolidated email per user containing all of *their* pending
// notifications. This both avoids spamming people with one email per event
// and guarantees per-user grouping (we never include another user's events
// in the same outbound email).
//
// Rows are kept after sending (sent_at IS NOT NULL) so the worker run can
// be audited / reproduced; a separate periodic prune is not implemented yet.
export const notificationQueueTable = pgTable(
  "notification_queue",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull(),
    eventKey: text("event_key").notNull(),
    subject: text("subject").notNull(),
    bodyText: text("body_text").notNull().default(""),
    bodyHtml: text("body_html").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (t) => ({
    pendingByUser: index("notification_queue_pending_idx").on(t.sentAt, t.userId),
  }),
);

export type NotificationQueueRow = typeof notificationQueueTable.$inferSelect;
