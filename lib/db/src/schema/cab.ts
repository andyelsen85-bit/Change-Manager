import { pgTable, serial, integer, text, timestamp, boolean, unique } from "drizzle-orm/pg-core";

export const cabMeetingsTable = pgTable("cab_meetings", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  kind: text("kind").notNull().default("cab"),
  scheduledStart: timestamp("scheduled_start", { withTimezone: true }).notNull(),
  scheduledEnd: timestamp("scheduled_end", { withTimezone: true }).notNull(),
  location: text("location").notNull().default(""),
  agenda: text("agenda").notNull().default(""),
  chairUserId: integer("chair_user_id"),
  status: text("status").notNull().default("scheduled"),
  minutes: text("minutes").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cabMembersTable = pgTable(
  "cab_members",
  {
    id: serial("id").primaryKey(),
    meetingId: integer("meeting_id").notNull(),
    userId: integer("user_id").notNull(),
    roleKey: text("role_key"),
    isDeputy: boolean("is_deputy").notNull().default(false),
  },
  (t) => ({ uniq: unique().on(t.meetingId, t.userId) }),
);

export const cabChangesTable = pgTable(
  "cab_changes",
  {
    id: serial("id").primaryKey(),
    meetingId: integer("meeting_id").notNull(),
    changeId: integer("change_id").notNull(),
  },
  (t) => ({ uniq: unique().on(t.meetingId, t.changeId) }),
);

export type CabMeetingRow = typeof cabMeetingsTable.$inferSelect;
export type CabMemberRow = typeof cabMembersTable.$inferSelect;
