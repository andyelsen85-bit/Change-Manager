import { pgTable, serial, integer, text, timestamp, boolean, unique, date } from "drizzle-orm/pg-core";

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
  recurrenceIntervalWeeks: integer("recurrence_interval_weeks"),
  recurrenceUntil: date("recurrence_until"),
  recurrenceGroupId: text("recurrence_group_id"),
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
    // Meeting-level outcome for this docket entry. Currently only "postponed"
    // is stored explicitly (approved/rejected are derived from the approvals
    // table at read time so the two can never diverge).
    outcome: text("outcome"),
    outcomeNote: text("outcome_note"),
    postponedToMeetingId: integer("postponed_to_meeting_id"),
  },
  (t) => ({ uniq: unique().on(t.meetingId, t.changeId) }),
);

// Attendance list of a meeting: seeded from users holding CAB roles, plus
// ad-hoc people added via the LDAP directory search (userId NULL for those).
export const cabAttendeesTable = pgTable(
  "cab_attendees",
  {
    id: serial("id").primaryKey(),
    meetingId: integer("meeting_id").notNull(),
    userId: integer("user_id"),
    name: text("name").notNull(),
    email: text("email").notNull().default(""),
    present: boolean("present").notNull().default(false),
  },
  (t) => ({ uniq: unique().on(t.meetingId, t.userId, t.email) }),
);

export type CabMeetingRow = typeof cabMeetingsTable.$inferSelect;
export type CabMemberRow = typeof cabMembersTable.$inferSelect;
export type CabAttendeeRow = typeof cabAttendeesTable.$inferSelect;
