import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import {
  DbMock,
  buildTestApp,
  ADMIN_SESSION,
  type SessionLike,
} from "./test-helpers";

const dbMock = new DbMock();
const getChangeAccessMock = vi.fn();

vi.mock("@workspace/db", () => ({
  db: dbMock,
  approvalsTable: { _t: "approvals" },
  changeRequestsTable: { _t: "change_requests" },
  cabMeetingsTable: { _t: "cab_meetings" },
  rolesTable: { _t: "roles" },
  usersTable: { _t: "users" },
  roleAssignmentsTable: { _t: "role_assignments" },
}));

vi.mock("drizzle-orm", () => ({ eq: () => ({}) }));

vi.mock("../lib/auth", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/auth")>("../lib/auth");
  return {
    ...actual,
    requireAuth: (req: unknown, _res: unknown, next: () => void) => next(),
    getChangeAccess: getChangeAccessMock,
  };
});

vi.mock("../lib/audit", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../lib/email", () => ({
  notify: vi.fn().mockResolvedValue(undefined),
  getUserEmail: vi.fn().mockResolvedValue(null),
}));

const { default: approvalsRouter } = await import("./approvals");

const DEPUTY_SESSION: SessionLike = {
  uid: 50,
  username: "deputy",
  isAdmin: false,
};

const PRIMARY_SESSION: SessionLike = {
  uid: 40,
  username: "primary",
  isAdmin: false,
};

const sampleAwaiting = {
  id: 1,
  ref: "NOR-1",
  title: "t",
  status: "awaiting_approval",
  track: "normal",
  ownerId: 10,
  assigneeId: 20,
  cabMeetingId: 5,
};

describe("POST /approvals/:id/vote — input validation & gates", () => {
  beforeEach(() => {
    dbMock.reset();
    getChangeAccessMock.mockReset();
  });

  it("rejects an unknown decision value", async () => {
    const app = buildTestApp(approvalsRouter, ADMIN_SESSION);
    const res = await request(app)
      .post("/api/approvals/7/vote")
      .send({ decision: "lol" });
    expect(res.status).toBe(400);
  });

  it("requires a non-trivial comment when rejecting", async () => {
    const app = buildTestApp(approvalsRouter, ADMIN_SESSION);
    const res = await request(app)
      .post("/api/approvals/7/vote")
      .send({ decision: "rejected", comment: "x" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/rejection.*3|at least 3/i);
  });

  it("returns 409 when the change is not in awaiting_approval status", async () => {
    dbMock.enqueue("select", [
      { id: 7, changeId: 1, roleKey: "change_manager", decision: "pending" },
    ]);
    dbMock.enqueue("select", [{ ...sampleAwaiting, status: "draft" }]);
    const app = buildTestApp(approvalsRouter, ADMIN_SESSION);
    const res = await request(app)
      .post("/api/approvals/7/vote")
      .send({ decision: "approved" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/awaiting approval/i);
  });

  it("returns 409 when CAB meeting is not yet completed", async () => {
    dbMock.enqueue("select", [
      { id: 7, changeId: 1, roleKey: "change_manager", decision: "pending" },
    ]);
    dbMock.enqueue("select", [sampleAwaiting]);
    dbMock.enqueue("select", [{ id: 5, status: "scheduled" }]);
    const app = buildTestApp(approvalsRouter, ADMIN_SESSION);
    const res = await request(app)
      .post("/api/approvals/7/vote")
      .send({ decision: "approved" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/cab.*concluded|after.*cab/i);
  });
});

describe("POST /approvals/:id/vote — deputy & auto-flip", () => {
  beforeEach(() => {
    dbMock.reset();
    getChangeAccessMock.mockReset();
  });

  it("allows a deputy assignment to vote and records viaDeputy=true", async () => {
    dbMock.enqueue("select", [
      { id: 7, changeId: 1, roleKey: "change_manager", decision: "pending" },
    ]);
    dbMock.enqueue("select", [sampleAwaiting]);
    dbMock.enqueue("select", [{ id: 5, status: "completed" }]);
    // role assignments — primary AND deputy. The current caller is the deputy.
    dbMock.enqueue("select", [
      { userId: 40, roleKey: "change_manager", isDeputy: false },
      { userId: 50, roleKey: "change_manager", isDeputy: true },
    ]);
    dbMock.enqueue("update", [
      {
        id: 7,
        changeId: 1,
        roleKey: "change_manager",
        decision: "approved",
        approverId: 50,
        viaDeputy: true,
      },
    ]);
    // recalculate approvals & status
    dbMock.enqueue("select", [
      { id: 7, decision: "approved" },
    ]);
    dbMock.enqueue("select", [{ status: "awaiting_approval" }]);
    dbMock.enqueue("update", undefined); // change.status -> approved
    dbMock.enqueue("select", [sampleAwaiting]); // change for audit/notify

    const app = buildTestApp(approvalsRouter, DEPUTY_SESSION);
    const res = await request(app)
      .post("/api/approvals/7/vote")
      .send({ decision: "approved" });

    expect(res.status).toBe(200);
    expect(res.body.viaDeputy).toBe(true);
    expect(res.body.status).toBe("approved");
  });

  it("primary voter records viaDeputy=false", async () => {
    dbMock.enqueue("select", [
      { id: 7, changeId: 1, roleKey: "change_manager", decision: "pending" },
    ]);
    dbMock.enqueue("select", [sampleAwaiting]);
    dbMock.enqueue("select", [{ id: 5, status: "completed" }]);
    dbMock.enqueue("select", [
      { userId: 40, roleKey: "change_manager", isDeputy: false },
      { userId: 50, roleKey: "change_manager", isDeputy: true },
    ]);
    dbMock.enqueue("update", [
      {
        id: 7,
        changeId: 1,
        roleKey: "change_manager",
        decision: "approved",
        approverId: 40,
        viaDeputy: false,
      },
    ]);
    dbMock.enqueue("select", [{ id: 7, decision: "approved" }]);
    dbMock.enqueue("select", [{ status: "awaiting_approval" }]);
    dbMock.enqueue("update", undefined);
    dbMock.enqueue("select", [sampleAwaiting]);

    const app = buildTestApp(approvalsRouter, PRIMARY_SESSION);
    const res = await request(app)
      .post("/api/approvals/7/vote")
      .send({ decision: "approved" });

    expect(res.status).toBe(200);
    expect(res.body.viaDeputy).toBe(false);
  });

  it("does not auto-flip the change when an approval is abstained (must be explicitly approved)", async () => {
    dbMock.enqueue("select", [
      { id: 7, changeId: 1, roleKey: "change_manager", decision: "pending" },
    ]);
    dbMock.enqueue("select", [
      { ...sampleAwaiting, track: "emergency" },
    ]);
    dbMock.enqueue("select", [{ id: 5, status: "completed" }]);
    dbMock.enqueue("select", [
      { userId: 50, roleKey: "change_manager", isDeputy: true },
    ]);
    dbMock.enqueue("update", [
      {
        id: 7,
        decision: "abstain",
        viaDeputy: true,
      },
    ]);
    // Two approvals total: this one (abstain) + an existing ecab_member approved.
    // allExplicitlyApproved must be false because of the abstain.
    dbMock.enqueue("select", [
      { id: 7, decision: "abstain" },
      { id: 8, decision: "approved" },
    ]);
    dbMock.enqueue("select", [sampleAwaiting]); // for audit/notify

    const app = buildTestApp(approvalsRouter, DEPUTY_SESSION);
    const res = await request(app)
      .post("/api/approvals/7/vote")
      .send({ decision: "abstain" });

    expect(res.status).toBe(200);
    // No auto-flip happened — status field should be null on the response.
    expect(res.body.status).toBeNull();
  });

  it("auto-flips to rejected as soon as any approval is rejected", async () => {
    dbMock.enqueue("select", [
      { id: 7, changeId: 1, roleKey: "ecab_member", decision: "pending" },
    ]);
    dbMock.enqueue("select", [
      { ...sampleAwaiting, track: "emergency" },
    ]);
    dbMock.enqueue("select", [{ id: 5, status: "completed" }]);
    dbMock.enqueue("select", [
      { userId: 50, roleKey: "ecab_member", isDeputy: false },
    ]);
    dbMock.enqueue("update", [
      { id: 7, decision: "rejected", viaDeputy: false },
    ]);
    dbMock.enqueue("select", [
      { id: 7, decision: "rejected" },
      { id: 8, decision: "approved" },
    ]);
    dbMock.enqueue("select", [{ status: "awaiting_approval" }]);
    dbMock.enqueue("update", undefined);
    dbMock.enqueue("select", [sampleAwaiting]);

    const app = buildTestApp(approvalsRouter, {
      uid: 50,
      username: "ecab",
      isAdmin: false,
    });
    const res = await request(app)
      .post("/api/approvals/7/vote")
      .send({
        decision: "rejected",
        comment: "Insufficient rollback plan documented.",
      });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("rejected");
  });
});
