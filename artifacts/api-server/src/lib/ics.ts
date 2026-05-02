import { createEvent, type EventAttributes, type DateArray } from "ics";
import type { CabMeetingRow, CabMemberRow, User } from "@workspace/db";

function toDateArray(d: Date): DateArray {
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()];
}

export function buildCabIcs(
  meeting: CabMeetingRow,
  members: Array<CabMemberRow & { email: string; fullName: string }>,
  organizer?: { name: string; email: string },
): string {
  const start = toDateArray(meeting.scheduledStart);
  const end = toDateArray(meeting.scheduledEnd);
  const ev: EventAttributes = {
    uid: `cab-${meeting.id}@change-mgmt`,
    title: meeting.title,
    description: meeting.agenda || `${meeting.kind === "ecab" ? "Emergency CAB" : "CAB"} meeting`,
    location: meeting.location,
    start,
    end,
    startInputType: "utc",
    endInputType: "utc",
    status: meeting.status === "cancelled" ? "CANCELLED" : "CONFIRMED",
    method: "REQUEST",
    organizer: organizer
      ? { name: organizer.name, email: organizer.email }
      : { name: "Change Management", email: "no-reply@change-mgmt.local" },
    attendees: members.map((m) => ({
      name: m.fullName,
      email: m.email,
      rsvp: true,
      partstat: "NEEDS-ACTION",
      role: m.isDeputy ? "OPT-PARTICIPANT" : "REQ-PARTICIPANT",
    })),
  };
  const { error, value } = createEvent(ev);
  if (error || !value) {
    throw new Error("Failed to build ICS: " + (error?.message ?? "unknown"));
  }
  return value;
}

export function _unused(_: User) {
  return _;
}
