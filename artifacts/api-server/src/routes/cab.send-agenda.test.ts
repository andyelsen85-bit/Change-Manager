import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { DbMock, buildTestApp, ADMIN_SESSION } from "./test-helpers";

const dbMock = new DbMock();

vi.mock("@workspace/db", () => ({
  db: dbMock,
  cabMeetingsTable: { _t: "cab_meetings", id: "id" },
  cabMembersTable: { _t: "cab_members" },
  cabChangesTable: { _t: "cab_changes" },
  changeRequestsTable: { _t: "change_requests", plannedStart: "planned_start", ref: "ref" },
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
  const actual = await vi.importActual<typeof import("../lib/auth")>("../lib/auth");
  return {
    ...actual,
    requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
    requireRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  };
});

vi.mock("../lib/audit", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));

const notifyMock = vi.fn().mockResolvedValue({ sent: 0, skipped: 0, errors: 0 });
const getUserEmailMock = vi.fn();
vi.mock("../lib/email", () => ({
  notify: (opts: unknown) => notifyMock(opts),
  getUserEmail: (uid: number) => getUserEmailMock(uid),
}));

const { default: cabRouter } = await import("./cab");
const { audit: auditMock } = await import("../lib/audit");

describe("POST /cab-meetings/:id/send-agenda", () => {
  beforeEach(() => {
    dbMock.reset();
    notifyMock.mockClear();
    notifyMock.mockResolvedValue({ sent: 2, skipped: 0, errors: 0 });
    getUserEmailMock.mockReset();
    (auditMock as ReturnType<typeof vi.fn>).mockClear();
  });

  it("returns 400 for a non-numeric id", async () => {
    const app = buildTestApp(cabRouter, ADMIN_SESSION);
    const res = await request(app).post("/api/cab-meetings/abc/send-agenda");
    expect(res.status).toBe(400);
  });

  it("returns 404 when the meeting does not exist", async () => {
    dbMock.enqueue("select", []);
    const app = buildTestApp(cabRouter, ADMIN_SESSION);
    const res = await request(app).post("/api/cab-meetings/9999/send-agenda");
    expect(res.status).toBe(404);
  });

  it("emails every member the full agenda with no ICS attachment, includes every change's details, and audits cab.agenda_sent", async () => {
    const meeting = {
      id: 77,
      title: "Weekly CAB",
      kind: "cab" as const,
      scheduledStart: new Date("2026-08-10T14:00:00Z"),
      scheduledEnd: new Date("2026-08-10T15:00:00Z"),
      location: "Boardroom A",
      agenda: "Standing review of pending changes",
      chairUserId: null,
      status: "scheduled",
      minutes: "",
      createdAt: new Date(),
    };
    const members = [
      { id: 1, meetingId: 77, userId: 100, roleKey: "change_manager", isDeputy: false, email: "alice@example.com", fullName: "Alice" },
      { id: 2, meetingId: 77, userId: 101, roleKey: "cab_member",     isDeputy: false, email: "bob@example.com",   fullName: "Bob"   },
    ];
    const changes = [
      {
        id: 500,
        ref: "CHG-0500",
        title: "Upgrade ingress controller",
        description: "Replace the current nginx ingress with the v2 build.\nIncludes config migration.",
        track: "normal",
        status: "awaiting_approval",
        risk: "medium",
        impact: "high",
        plannedStart: new Date("2026-08-12T02:00:00Z"),
        plannedEnd:   new Date("2026-08-12T04:00:00Z"),
      },
      {
        id: 501,
        ref: "CHG-0501",
        title: "Rotate TLS certificates",
        description: "",
        track: "standard",
        status: "scheduled",
        risk: "low",
        impact: "low",
        plannedStart: null,
        plannedEnd: null,
      },
    ];

    dbMock.enqueue("select", [meeting]);   // meeting lookup
    dbMock.enqueue("select", members);     // member rows
    dbMock.enqueue("select", changes);     // change rows
    getUserEmailMock.mockImplementation((uid: number) =>
      uid === 100
        ? Promise.resolve({ userId: 100, email: "alice@example.com", name: "Alice" })
        : Promise.resolve({ userId: 101, email: "bob@example.com", name: "Bob" }),
    );

    const app = buildTestApp(cabRouter, ADMIN_SESSION);
    const res = await request(app).post("/api/cab-meetings/77/send-agenda");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: 2, skipped: 0, errors: 0 });

    expect(notifyMock).toHaveBeenCalledTimes(1);
    const call = notifyMock.mock.calls[0]?.[0] as {
      eventKey: string;
      subject: string;
      text: string;
      to: Array<{ email: string }>;
      ics?: unknown;
    };
    // Notification preference key must remain stable for backward compat
    expect(call.eventKey).toBe("cab.invited");
    // No calendar attachment on the agenda email
    expect(call.ics).toBeUndefined();
    // Subject identifies this as an agenda for a CAB
    expect(call.subject).toMatch(/^\[CAB Agenda\] Weekly CAB/);
    // Both targets resolved
    expect(call.to.map((t) => t.email).sort()).toEqual(["alice@example.com", "bob@example.com"]);

    const body = call.text;
    expect(body).toContain("CAB agenda — Weekly CAB");
    expect(body).toContain("Where: Boardroom A");
    expect(body).toContain("Standing review of pending changes");
    expect(body).toContain("Changes for review (2):");
    // Change 1 details
    expect(body).toContain("[CHG-0500] Upgrade ingress controller");
    expect(body).toContain("Risk: Medium");
    expect(body).toContain("Impact: High");
    expect(body).toContain("Planned start:");
    expect(body).toContain("Planned end:");
    expect(body).toContain("Replace the current nginx ingress");
    expect(body).toContain("Includes config migration.");
    // Change 2 details — empty description must show placeholder, missing dates "TBD"
    expect(body).toContain("[CHG-0501] Rotate TLS certificates");
    expect(body).toContain("(no description provided)");
    expect(body).toContain("TBD");

    // Audit action renamed
    expect(auditMock).toHaveBeenCalledTimes(1);
    const auditArgs = (auditMock as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as {
      action: string;
      summary: string;
      after: { changeCount: number };
    };
    expect(auditArgs.action).toBe("cab.agenda_sent");
    expect(auditArgs.after.changeCount).toBe(2);
    expect(auditArgs.summary).toContain("2 changes");
  });

  it("renders an empty-agenda placeholder when no changes are attached", async () => {
    const meeting = {
      id: 88,
      title: "Empty CAB",
      kind: "ecab" as const,
      scheduledStart: new Date("2026-09-01T10:00:00Z"),
      scheduledEnd: new Date("2026-09-01T11:00:00Z"),
      location: "Bridge",
      agenda: "",
      chairUserId: null,
      status: "scheduled",
      minutes: "",
      createdAt: new Date(),
    };
    dbMock.enqueue("select", [meeting]);
    dbMock.enqueue("select", []);
    dbMock.enqueue("select", []);
    getUserEmailMock.mockResolvedValue(null);
    notifyMock.mockResolvedValue({ sent: 0, skipped: 0, errors: 0 });

    const app = buildTestApp(cabRouter, ADMIN_SESSION);
    const res = await request(app).post("/api/cab-meetings/88/send-agenda");

    expect(res.status).toBe(200);
    const call = notifyMock.mock.calls[0]?.[0] as { subject: string; text: string };
    expect(call.subject).toMatch(/^\[eCAB Agenda\]/);
    expect(call.text).toContain("Changes for review (0):");
    expect(call.text).toContain("(no changes on the agenda)");
    expect(call.text).toContain("(none)"); // empty meeting notes
  });
});
