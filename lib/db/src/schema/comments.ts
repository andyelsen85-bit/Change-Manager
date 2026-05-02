import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";

export const commentsTable = pgTable("comments", {
  id: serial("id").primaryKey(),
  changeId: integer("change_id").notNull(),
  authorId: integer("author_id").notNull(),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type CommentRow = typeof commentsTable.$inferSelect;
