import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { DbMock, buildTestApp, ADMIN_SESSION } from "./test-helpers";

const dbMock = new DbMock();

vi.mock("@workspace/db", () => ({
  db: dbMock,
  cabMeetingsTable: { _t: "cab_meetings", id: "id" },
  cabMembersTable: { _t: "cab_members" },
  cabChangesTable: { _t: "cab_changes", meetingId: "meeting_id", changeId: "change_id", id: "id" },
  cabAttendeesTable: { _t: "cab_attendees" },
  changeRequestsTable: { _t: "change_requests", plannedStart: "planned_start", ref: "ref" },
  roleAssignmentsTable: { _t: "role_assignments", userId: "user_id", roleKey: "role_key" },
  usersTable: { _t: "users" },
}));

const notInArrayMock = vi.fn((_col: unknown, _vals: unknown) => ({ _op: "notInArray" }));
const inArrayMock = vi.fn((_col: unknown, _vals: unknown) => ({ _op: "inArray" }));
vi.mock("drizzle-orm", () => ({
  and: () => ({}),
  asc: () => ({}),
  eq: () => ({}),
  gte: () => ({}),
  lte: () => ({}),
  inArray: (col: unknown, vals: unknown) => inArrayMock(col, vals),
  notInArray: (col: unknown, vals: unknown) => notInArrayMock(col, vals),
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
vi.mock("../lib/ics", () => ({ buildCabIcs: vi.fn(() => "ICS") }));

const buildAgendaPdfMock = vi.fn();
const buildResultsPdfMock = vi.fn();
vi.mock("../lib/agenda-pdf", () => ({
  buildCabAgendaPdf: (id: number) => buildAgendaPdfMock(id),
  buildCabResultsPdf: (id: number) => buildResultsPdfMock(id),
}));

const notifyMock = vi.fn();
const getUserEmailMock = vi.fn();
const getUserEmailsMock = vi.fn();
vi.mock("../lib/email", () => ({
  notify: (opts: unknown) => notifyMock(opts),
  getUserEmail: (uid: number) => getUserEmailMock(uid),
  getUserEmails: (ids: number[]) => getUserEmailsMock(ids),
}));

const { default: cabRouter } = await import("./cab");
const { audit: auditMock } = await import("../lib/audit");

const app = buildTestApp(cabRouter, ADMIN_SESSION);

const meeting = (over: Record<string, unknown> = {}) => ({
  id: 5,
  title: "Weekly CAB",
  kind: "cab" as const,
  scheduledStart: new Date("2026-08-10T14:00:00Z"),
  scheduledEnd: new Date("2026-08-10T15:00:00Z"),
  location: "Boardroom",
  agenda: "",
  status: "scheduled",
  minutes: "",
  createdAt: new Date(),
  ...over,
});

beforeEach(() => {
  dbMock.reset();
  notifyMock.mockReset().mockResolvedValue({ sent: 0, skipped: 0, errors: 0 });
  getUserEmailMock.mockReset();
  getUserEmailsMock.mockReset().mockResolvedValue([]);
  buildAgendaPdfMock.mockReset().mockResolvedValue(null);
  buildResultsPdfMock.mockReset().mockResolvedValue(null);
  inArrayMock.mockClear();
  notInArrayMock.mockClear();
  (auditMock as ReturnType<typeof vi.fn>).mockClear();
});

describe("GET /cab-meetings/:id/attendance", () => {
  it("returns 404 when the meeting does not exist", async () => {
    dbMock.enqueue("select", []);
    const res = await request(app).get("/api/cab-meetings/5/attendance");
    expect(res.status).toBe(404);
  });

  it("merges role-holders with stored rows: stored wins, inactive skipped, ex-role rows kept, externals flagged ad-hoc", async () => {
    dbMock.enqueue("select", [meeting()]);
    // stored attendance rows
    dbMock.enqueue("select", [
      { id: 1, meetingId: 5, userId: 100, name: "Alice Stored", email: "alice@x.com", present: true },
      { id: 2, meetingId: 5, userId: 300, name: "Gone Guy", email: "gone@x.com", present: true },
      { id: 3, meetingId: 5, userId: null, name: "External Ada", email: "ada@ext.com", present: false },
    ]);
    // role holders (with a duplicate and an inactive user)
    dbMock.enqueue("select", [
      { userId: 100, name: "Alice", email: "alice@x.com", isActive: true },
      { userId: 100, name: "Alice", email: "alice@x.com", isActive: true },
      { userId: 200, name: "Bob", email: "bob@x.com", isActive: true },
      { userId: 400, name: "Inactive Ivan", email: "ivan@x.com", isActive: false },
    ]);

    const res = await request(app).get("/api/cab-meetings/5/attendance");
    expect(res.status).toBe(200);
    const list = res.body.attendees as Array<{
      userId: number | null; name: string; email: string; present: boolean; adHoc: boolean;
    }>;
    // Sorted by name; inactive Ivan excluded; Alice appears exactly once.
    expect(list.map((a) => a.name)).toEqual(["Alice", "Bob", "External Ada", "Gone Guy"]);
    const alice = list.find((a) => a.userId === 100)!;
    expect(alice.present).toBe(true); // stored row wins over seeded default
    expect(alice.adHoc).toBe(false);
    const bob = list.find((a) => a.userId === 200)!;
    expect(bob.present).toBe(false);
    // Stored row for a user who no longer holds a CAB role stays visible.
    const gone = list.find((a) => a.userId === 300)!;
    expect(gone.present).toBe(true);
    expect(gone.adHoc).toBe(false);
    const ext = list.find((a) => a.userId === null)!;
    expect(ext.adHoc).toBe(true);
    expect(ext.email).toBe("ada@ext.com");
    // eCAB/CAB role selection goes through inArray on role keys.
    expect(inArrayMock).toHaveBeenCalledWith("role_key", ["cab_member", "cab_chair"]);
  });

  it("seeds ecab_member (not cab_member) role holders for eCAB meetings", async () => {
    dbMock.enqueue("select", [meeting({ kind: "ecab" })]);
    dbMock.enqueue("select", []);
    dbMock.enqueue("select", []);
    const res = await request(app).get("/api/cab-meetings/5/attendance");
    expect(res.status).toBe(200);
    expect(inArrayMock).toHaveBeenCalledWith("role_key", ["ecab_member", "cab_chair"]);
  });
});

describe("PUT /cab-meetings/:id/attendance", () => {
  it("400s without an attendees array", async () => {
    dbMock.enqueue("select", [meeting()]);
    const res = await request(app).put("/api/cab-meetings/5/attendance").send({});
    expect(res.status).toBe(400);
  });

  it("replaces the stored list, deduping by userId, external email (case-insensitive), and name fallback", async () => {
    dbMock.enqueue("select", [meeting()]);
    dbMock.enqueue("delete", []);
    dbMock.enqueue("insert", []);
    const res = await request(app)
      .put("/api/cab-meetings/5/attendance")
      .send({
        attendees: [
          { userId: 100, name: "Alice", email: "alice@x.com", present: true },
          { userId: 100, name: "Alice Again", email: "other@x.com", present: false }, // dup userId
          { name: "External One", email: "EXT@x.com", present: true },
          { name: "External Dup", email: "ext@x.com", present: false }, // dup email (case-insensitive)
          { name: "", email: "noname@x.com" }, // no name -> skipped
          { name: "NoEmail Guy", present: true },
          { name: "noemail guy" }, // dup by lowercased name
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, count: 3 });
    const valuesCall = dbMock.log.find((e) => e.call === "insert" && e.method === "values");
    const rows = valuesCall?.args[0] as Array<{ userId: number | null; name: string; email: string; present: boolean }>;
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.name)).toEqual(["Alice", "External One", "NoEmail Guy"]);
    expect(rows.find((r) => r.name === "External One")?.email).toBe("EXT@x.com");
    expect(rows.find((r) => r.name === "NoEmail Guy")?.userId).toBeNull();
  });
});

describe("POST /cab-meetings/:id/changes/:changeId/postpone", () => {
  const target = meeting({ id: 6, title: "Next CAB" });
  const docket = { id: 9, meetingId: 5, changeId: 42, outcome: null, outcomeNote: null, postponedToMeetingId: null };
  const chg = { id: 42, ref: "CHG-0042", title: "Some change", deletedAt: null };

  it("400s when the target is the same meeting", async () => {
    const res = await request(app)
      .post("/api/cab-meetings/5/changes/42/postpone")
      .send({ targetMeetingId: 5 });
    expect(res.status).toBe(400);
  });

  it("409s when the target meeting is completed", async () => {
    dbMock.enqueue("select", [meeting()]);
    dbMock.enqueue("select", [meeting({ id: 6, status: "completed" })]);
    const res = await request(app)
      .post("/api/cab-meetings/5/changes/42/postpone")
      .send({ targetMeetingId: 6 });
    expect(res.status).toBe(409);
  });

  it("404s when the change is not on this meeting", async () => {
    dbMock.enqueue("select", [meeting()]);
    dbMock.enqueue("select", [target]);
    dbMock.enqueue("select", []); // no docket row
    const res = await request(app)
      .post("/api/cab-meetings/5/changes/42/postpone")
      .send({ targetMeetingId: 6 });
    expect(res.status).toBe(404);
  });

  it("marks the source docket postponed, dockets on the target with stale-outcome reset, and relinks the change", async () => {
    dbMock.enqueue("select", [meeting()]);
    dbMock.enqueue("select", [target]);
    dbMock.enqueue("select", [docket]);
    dbMock.enqueue("select", [chg]);
    dbMock.enqueue("update", []); // mark source row postponed
    dbMock.enqueue("insert", []); // upsert on target
    dbMock.enqueue("update", []); // change_requests.cabMeetingId
    // expandMeeting
    dbMock.enqueue("select", []); // members
    dbMock.enqueue("select", [
      { id: 42, ref: "CHG-0042", title: "Some change", track: "normal", status: "awaiting_approval", risk: "low", outcome: "postponed", outcomeNote: "next week", postponedToMeetingId: 6 },
    ]);

    const res = await request(app)
      .post("/api/cab-meetings/5/changes/42/postpone")
      .send({ targetMeetingId: 6, note: "next week" });
    expect(res.status).toBe(200);
    expect(res.body.changes[0].outcome).toBe("postponed");
    expect(res.body.changes[0].postponedToMeetingId).toBe(6);

    // Source docket row updated to postponed with the note.
    const setCall = dbMock.log.find((e) => e.call === "update" && e.method === "set");
    expect(setCall?.args[0]).toEqual({ outcome: "postponed", outcomeNote: "next week", postponedToMeetingId: 6 });

    // Target upsert resets any stale outcome (re-postponed back scenario).
    const upsert = dbMock.log.find((e) => e.method === "onConflictDoUpdate");
    expect(upsert).toBeTruthy();
    expect((upsert?.args[0] as { set: unknown }).set).toEqual({
      outcome: null,
      outcomeNote: null,
      postponedToMeetingId: null,
    });

    const auditArgs = (auditMock as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as { action: string; summary: string };
    expect(auditArgs.action).toBe("cab.change_postponed");
    expect(auditArgs.summary).toContain("CHG-0042");
  });
});

describe("PATCH /cab-meetings/:id (docket diff)", () => {
  it("diffs the docket with notInArray instead of delete-all, preserving outcome columns", async () => {
    dbMock.enqueue("select", [meeting()]);
    dbMock.enqueue("delete", []); // delete rows NOT in wanted
    dbMock.enqueue("insert", []); // cid 1
    dbMock.enqueue("update", []);
    dbMock.enqueue("insert", []); // cid 2
    dbMock.enqueue("update", []);
    // expandMeeting
    dbMock.enqueue("select", []);
    dbMock.enqueue("select", []);

    const res = await request(app).patch("/api/cab-meetings/5").send({ changeIds: [1, 2] });
    expect(res.status).toBe(200);
    // The delete is scoped by notInArray(changeId, wanted) — never a blanket
    // delete of all docket rows (that would erase stored outcomes).
    expect(notInArrayMock).toHaveBeenCalledTimes(1);
    expect(notInArrayMock).toHaveBeenCalledWith("change_id", [1, 2]);
    expect(dbMock.log.filter((e) => e.method === "delete")).toHaveLength(1);
    // Re-inserts are conflict-tolerant so existing rows (and their outcome
    // columns) are left untouched.
    const inserts = dbMock.log.filter((e) => e.method === "onConflictDoNothing");
    expect(inserts).toHaveLength(2);
  });

  it("clears the docket entirely when changeIds is an empty array", async () => {
    dbMock.enqueue("select", [meeting()]);
    dbMock.enqueue("delete", []);
    dbMock.enqueue("select", []);
    dbMock.enqueue("select", []);
    const res = await request(app).patch("/api/cab-meetings/5").send({ changeIds: [] });
    expect(res.status).toBe(200);
    expect(notInArrayMock).not.toHaveBeenCalled();
  });
});

describe("POST /cab-meetings/:id/complete — results email", () => {
  const before = meeting({ id: 7, title: "Big CAB" });
  const completed = { ...before, status: "completed" };
  const pdf = { filename: "results.pdf", content: Buffer.from("pdf") };

  it("emails role holders plus external attendees with negative userIds, deduped by email", async () => {
    dbMock.enqueue("select", [before]);
    dbMock.enqueue("update", [completed]);
    buildResultsPdfMock.mockResolvedValue(pdf);
    dbMock.enqueue("select", [{ userId: 1 }, { userId: 2 }, { userId: 1 }]); // role rows (dup)
    getUserEmailsMock.mockResolvedValue([
      { userId: 1, email: "one@x.com", name: "One" },
      { userId: 2, email: "two@x.com", name: "Two" },
    ]);
    dbMock.enqueue("select", [
      { userId: null, name: "Dup Of Role", email: "One@X.com", present: true }, // dup of role target
      { userId: null, name: "Ext B", email: "extb@x.com", present: true },
      { userId: null, name: "Ext B Again", email: "EXTB@x.com", present: false }, // dup external
      { userId: null, name: "No Mail", email: "not-an-email", present: true }, // no @ -> skipped
      { userId: 5, name: "Local User", email: "local@x.com", present: true }, // has account -> covered by role path
    ]);
    notifyMock.mockResolvedValue({ sent: 3, skipped: 0, errors: 0 });
    // expandMeeting
    dbMock.enqueue("select", []);
    dbMock.enqueue("select", []);

    const res = await request(app).post("/api/cab-meetings/7/complete");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("completed");
    expect(res.body.resultsMail).toEqual({ sent: 3, skipped: 0, errors: 0 });

    // Role userIds deduped before the email lookup.
    expect(getUserEmailsMock).toHaveBeenCalledWith([1, 2]);

    expect(notifyMock).toHaveBeenCalledTimes(1);
    const call = notifyMock.mock.calls[0]?.[0] as {
      eventKey: string;
      to: Array<{ userId: number; email: string }>;
      pdf: { filename: string };
    };
    expect(call.eventKey).toBe("cab.minutes");
    expect(call.pdf.filename).toBe("results.pdf");
    expect(call.to.map((t) => t.email)).toEqual(["one@x.com", "two@x.com", "extb@x.com"]);
    // External gets a synthetic negative pseudo-id.
    expect(call.to.find((t) => t.email === "extb@x.com")?.userId).toBe(-1);

    const auditActions = (auditMock as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[1] as { action: string }).action);
    expect(auditActions).toContain("cab.completed");
    expect(auditActions).toContain("cab.results_sent");
  });

  it("still completes the meeting when the results mail fails", async () => {
    dbMock.enqueue("select", [before]);
    dbMock.enqueue("update", [completed]);
    buildResultsPdfMock.mockResolvedValue(pdf);
    dbMock.enqueue("select", []); // role rows
    dbMock.enqueue("select", []); // attendees
    notifyMock.mockRejectedValue(new Error("smtp down"));
    dbMock.enqueue("select", []);
    dbMock.enqueue("select", []);

    const res = await request(app).post("/api/cab-meetings/7/complete");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("completed");
    expect(res.body.resultsMail).toBeNull();
  });

  it("still completes the meeting when PDF generation fails", async () => {
    dbMock.enqueue("select", [before]);
    dbMock.enqueue("update", [completed]);
    buildResultsPdfMock.mockRejectedValue(new Error("pdf boom"));
    dbMock.enqueue("select", []);
    dbMock.enqueue("select", []);

    const res = await request(app).post("/api/cab-meetings/7/complete");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("completed");
    expect(res.body.resultsMail).toBeNull();
    expect(notifyMock).not.toHaveBeenCalled();
  });
});
