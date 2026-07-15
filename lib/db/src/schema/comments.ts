import { pgTable, serial, integer, text, timestamp, primaryKey } from "drizzle-orm/pg-core";

export const commentsTable = pgTable("comments", {
  id: serial("id").primaryKey(),
  changeId: integer("change_id").notNull(),
  authorId: integer("author_id").notNull(),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type CommentRow = typeof commentsTable.$inferSelect;

// Per-user discussion read state: one row per (user, change). "Unread" =
// newest comment createdAt > lastReadAt (or no row at all).
export const discussionReadsTable = pgTable(
  "discussion_reads",
  {
    userId: integer("user_id").notNull(),
    changeId: integer("change_id").notNull(),
    lastReadAt: timestamp("last_read_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.changeId] })],
);

export type DiscussionReadRow = typeof discussionReadsTable.$inferSelect;
