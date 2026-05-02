import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import {
  DbMock,
  buildTestApp,
  OWNER_SESSION,
  ADMIN_SESSION,
} from "./test-helpers";

const dbMock = new DbMock();

vi.mock("@workspace/db", () => ({
  db: dbMock,
  cabMeetingsTable: { _t: "cab_meetings", id: "id" },
  cabMembersTable: { _t: "cab_members" },
  cabChangesTable: { _t: "cab_changes" },
  changeRequestsTable: { _t: "change_requests" },
  usersTable: { _t: "users" },
}));

vi.mock("drizzle-orm", () => ({
  and: () => ({}),
  asc: () => ({}),
  eq: () => ({}),
  gte: () => ({}),
  lte: () => ({}),
}));

vi.mock("../lib/auth", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/auth")>("../lib/auth");
  return {
    ...actual,
    requireAuth: (req: unknown, _res: unknown, next: () => void) => next(),
    requireRole: () => (req: unknown, _res: unknown, next: () => void) => next(),
  };
});

vi.mock("../lib/audit", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../lib/email", () => ({
  notify: vi.fn().mockResolvedValue({ sent: 0, skipped: 0, errors: 0 }),
  getUserEmail: vi.fn().mockResolvedValue(null),
}));

const { default: cabRouter } = await import("./cab");

describe("GET /cab-meetings/:id/ics", () => {
  beforeEach(() => {
    dbMock.reset();
  });

  it("returns 404 when the meeting does not exist", async () => {
    dbMock.enqueue("select", []);
    const app = buildTestApp(cabRouter, OWNER_SESSION);
    const res = await request(app).get("/api/cab-meetings/9999/ics");
    expect(res.status).toBe(404);
  });

  it("returns 400 for a non-numeric id", async () => {
    const app = buildTestApp(cabRouter, OWNER_SESSION);
    const res = await request(app).get("/api/cab-meetings/abc/ics");
    expect(res.status).toBe(400);
  });

  it("renders an RFC 5545 calendar with attendees, organizer, status=CONFIRMED, and method=REQUEST", async () => {
    const meeting = {
      id: 42,
      title: "Weekly CAB",
      kind: "cab",
      scheduledStart: new Date("2026-06-01T14:00:00Z"),
      scheduledEnd: new Date("2026-06-01T15:00:00Z"),
      location: "Boardroom",
      agenda: "Review pending changes",
      chairUserId: 100,
      status: "scheduled",
      minutes: "",
      createdAt: new Date(),
    };
    dbMock.enqueue("select", [meeting]);
    dbMock.enqueue("select", [
      {
        id: 1,
        meetingId: 42,
        userId: 200,
        roleKey: "change_manager",
        isDeputy: false,
        email: "alice@example.com",
        fullName: "Alice Approver",
      },
      {
        id: 2,
        meetingId: 42,
        userId: 201,
        roleKey: "ecab_member",
        isDeputy: true,
        email: "bob@example.com",
        fullName: "Bob Deputy",
      },
    ]);

    const app = buildTestApp(cabRouter, ADMIN_SESSION);
    const res = await request(app).get("/api/cab-meetings/42/ics");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/calendar/);
    expect(res.headers["content-disposition"]).toContain('cab-42.ics');
    const body = res.text;
    expect(body).toContain("BEGIN:VCALENDAR");
    expect(body).toContain("END:VCALENDAR");
    expect(body).toContain("BEGIN:VEVENT");
    expect(body).toContain("END:VEVENT");
    expect(body).toContain("METHOD:REQUEST");
    expect(body).toContain("STATUS:CONFIRMED");
    expect(body).toContain("SUMMARY:Weekly CAB");
    expect(body).toContain("LOCATION:Boardroom");
    expect(body).toContain("alice@example.com");
    expect(body).toContain("bob@example.com");
    // Stable UID per meeting
    expect(body).toContain("UID:cab-42@change-mgmt");
    // Deputy is marked OPT-PARTICIPANT, primary is REQ-PARTICIPANT
    expect(body).toMatch(/ROLE="?OPT-PARTICIPANT"?[\s\S]*bob@example\.com/);
    expect(body).toMatch(/ROLE="?REQ-PARTICIPANT"?[\s\S]*alice@example\.com/);
  });

  it("emits STATUS:CANCELLED for a cancelled meeting", async () => {
    const meeting = {
      id: 43,
      title: "Cancelled meeting",
      kind: "ecab",
      scheduledStart: new Date("2026-07-01T14:00:00Z"),
      scheduledEnd: new Date("2026-07-01T15:00:00Z"),
      location: "",
      agenda: "",
      chairUserId: null,
      status: "cancelled",
      minutes: "",
      createdAt: new Date(),
    };
    dbMock.enqueue("select", [meeting]);
    dbMock.enqueue("select", []);
    const app = buildTestApp(cabRouter, ADMIN_SESSION);
    const res = await request(app).get("/api/cab-meetings/43/ics");
    expect(res.status).toBe(200);
    expect(res.text).toContain("STATUS:CANCELLED");
  });
});
