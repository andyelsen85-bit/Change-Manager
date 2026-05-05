import { pgTable, serial, text, integer, boolean, unique } from "drizzle-orm/pg-core";

export const changeCategoriesTable = pgTable(
  "change_categories",
  {
    id: serial("id").primaryKey(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
  },
  (t) => ({
    keyUnique: unique().on(t.key),
  }),
);

export type ChangeCategory = typeof changeCategoriesTable.$inferSelect;
export type InsertChangeCategory = typeof changeCategoriesTable.$inferInsert;
